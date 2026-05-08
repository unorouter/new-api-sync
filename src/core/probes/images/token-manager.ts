import type { ClientContext } from "@core/vendors/newapi/context";
import {
  createToken,
  deleteToken,
  getTokenFullKey,
  listTokens,
} from "@core/vendors/newapi/tokens";
import type { UpstreamToken } from "@core/vendors/newapi/types";
import { consola } from "consola";

/**
 * Lazy per-provider token cache for the image probe.
 *
 * Background: previously we bulk-resolved every group's full key up front
 * via `ensureTokens`. On providers that rate-limit `/api/token/{id}/key`
 * (e.g. pol returns 429 on every call), 50+ sequential resolves all fail
 * and the run aborts. The fix: list existing tokens ONCE per provider,
 * cache the masked metadata in memory, and only resolve / create / delete
 * on demand when the probe actually walks into that group.
 *
 * Behaviour:
 * - `getApiKey(group)` returns a usable inference key. If a `<group>-image`
 *   token already exists upstream, resolve its full key on first use and
 *   cache. If missing, create one. Cached forever after success.
 * - All upstream calls retry on 429 with exponential backoff so a single
 *   throttle blip doesn't drop the whole probe.
 * - Tokens this manager created during the run are tracked, so `cleanup()`
 *   can delete them after probing finishes (existing tokens are NEVER
 *   deleted - they belong to the user's regular workflow).
 */
export class ProbeTokenManager {
  private tokensByName = new Map<string, UpstreamToken>();
  private resolvedKeys = new Map<string, string>(); // group -> sk-...
  private createdByThisRun = new Set<number>();
  private listed = false;

  constructor(
    private ctx: ClientContext,
    private providerName: string,
    /** Token name suffix; `<group>-<prefix>`. */
    private prefix: string = "image",
  ) {}

  /**
   * Cache existing tokens once per run. Subsequent calls return the cache.
   * Pagination + 429 retry are handled by `listTokens` already.
   */
  async preloadList(): Promise<void> {
    if (this.listed) return;
    const all = await retryOn429(() => listTokens(this.ctx));
    for (const t of all) this.tokensByName.set(t.name, t);
    this.listed = true;
    consola.info(
      `[${this.providerName}] token cache: ${this.tokensByName.size} existing`,
    );
  }

  /**
   * Resolve the inference API key for a group on first probe. Creates a
   * token if missing, fetches the full key (masked -> unmasked) if the
   * upstream returned a redacted form. Caches success so repeat calls are
   * free.
   *
   * Returns null when key acquisition fails (e.g. upstream throttles `/key`
   * permanently for system tokens). The probe loop should treat null as
   * "skip this group" rather than aborting the whole provider.
   */
  async getApiKey(groupName: string): Promise<string | null> {
    const cached = this.resolvedKeys.get(groupName);
    if (cached) return cached;

    await this.preloadList();
    const tokenName = this.tokenNameFor(groupName);
    let token = this.tokensByName.get(tokenName);

    if (!token) {
      // Create on demand - one POST per group, only when first probed.
      const ok = await retryOn429(() =>
        createToken(this.ctx, tokenName, groupName),
      );
      if (!ok) return null;

      // POST /api/token/ doesn't return the new id, so re-list to find it.
      // We accept the cost of one extra paginated list per created token
      // because in steady state most groups already have tokens cached.
      const refreshed = await retryOn429(() => listTokens(this.ctx));
      for (const t of refreshed) this.tokensByName.set(t.name, t);
      token = this.tokensByName.get(tokenName);
      if (!token) return null;
      this.createdByThisRun.add(token.id);
    }

    // Resolve full key. Masked keys come back as `A8wt**********h3Ov`;
    // call /api/token/{id}/key to unmask. If that endpoint 429s
    // permanently, give up on this group rather than retrying forever.
    let key = token.key;
    if (key.includes("**")) {
      const fetched = await retryOn429(
        () => getTokenFullKey(this.ctx, token!.id),
        { maxAttempts: 4 },
      );
      if (!fetched) return null;
      key = fetched;
    }
    if (!key) return null;

    const normalized = key.startsWith("sk-") ? key : `sk-${key}`;
    this.resolvedKeys.set(groupName, normalized);
    return normalized;
  }

  /**
   * Delete tokens this manager created during the run. Existing tokens
   * (already on upstream before the run started) are LEFT ALONE — they
   * may belong to the user's regular sync workflow and we never own them.
   * Deletes are best-effort; failures log a warning but don't throw.
   */
  async cleanup(): Promise<void> {
    if (this.createdByThisRun.size === 0) return;
    consola.info(
      `[${this.providerName}] cleaning up ${this.createdByThisRun.size} probe-created tokens`,
    );
    for (const id of this.createdByThisRun) {
      try {
        await retryOn429(() => deleteToken(this.ctx, id));
      } catch (err) {
        consola.warn(
          `[${this.providerName}] failed to delete probe token ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private tokenNameFor(groupName: string): string {
    // Mirror ensureTokens' truncation rule: 30 bytes max name, suffix
    // `-{prefix}` reserved at the end. Most group names fit comfortably,
    // but some Chinese / emoji groups exceed the limit when UTF-8 encoded.
    const TOKEN_NAME_MAX_BYTES = 30;
    const suffix = `-${this.prefix}`;
    const encoder = new TextEncoder();
    const suffixBytes = encoder.encode(suffix).length;
    const maxBytes = TOKEN_NAME_MAX_BYTES - suffixBytes;
    if (encoder.encode(groupName).length <= maxBytes) {
      return `${groupName}${suffix}`;
    }
    let truncated = "";
    let usedBytes = 0;
    for (const char of groupName) {
      const charBytes = encoder.encode(char).length;
      if (usedBytes + charBytes > maxBytes) break;
      truncated += char;
      usedBytes += charBytes;
    }
    return `${truncated}${suffix}`;
  }
}

// ---------------------------------------------------------------------------
// 429-aware retry helper
// ---------------------------------------------------------------------------

interface RetryOpts {
  /** Number of attempts INCLUDING the first call. Default 5. */
  maxAttempts?: number;
  /** Base delay in ms; doubles on each retry. Default 2000ms. */
  baseDelayMs?: number;
}

/**
 * Run an async fn with exponential backoff specifically targeting 429
 * (rate-limit) failures. Errors that don't smell like 429s propagate
 * immediately so we don't silently retry real bugs.
 *
 * Identifies 429 by message substring, since the call sites surface
 * various error shapes (Error from fetchJson, returned-null from
 * tryFetchJson, throwOnError-disabled paths). Best-effort detection;
 * a slightly noisier rate-limit retry is preferable to dropping the
 * whole provider.
 */
async function retryOn429<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 2000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit =
        /\b429\b|rate ?limit|too many requests/i.test(msg);
      if (!isRateLimit || attempt === max) throw err;
      const delay = base * 2 ** (attempt - 1);
      consola.debug(
        `retry attempt ${attempt}/${max} after ${delay}ms (rate limited)`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
