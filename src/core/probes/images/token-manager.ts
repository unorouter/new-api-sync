import { retryOn429 } from "@core/infra/retry";
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
 * Lazy per-provider token cache. Lists tokens once at start, then unmasks
 * keys on demand per group so providers that 429 every /key call (e.g. pol)
 * only fail the groups whose key actually resolves, not the whole run.
 * cleanup() deletes only tokens created during this run.
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

  /** Cache existing tokens once per run. */
  async preloadList(): Promise<void> {
    if (this.listed) return;
    const all = await retryOn429(() => listTokens(this.ctx));
    for (const t of all) this.tokensByName.set(t.name, t);
    this.listed = true;
    consola.info(
      `[${this.providerName}] cached ${this.tokensByName.size} tokens`,
    );
  }

  /** Resolve key on first visit. Returns null when /key is 429-throttled permanently — caller skips the group. */
  async getApiKey(groupName: string): Promise<string | null> {
    const cached = this.resolvedKeys.get(groupName);
    if (cached) return cached;

    await this.preloadList();
    const tokenName = this.tokenNameFor(groupName);
    let token = this.tokensByName.get(tokenName);

    if (!token) {
      const ok = await retryOn429(() =>
        createToken(this.ctx, tokenName, groupName),
      );
      if (!ok) return null;
      // POST /api/token/ returns no id; one extra paginated list per created token.
      const refreshed = await retryOn429(() => listTokens(this.ctx));
      for (const t of refreshed) this.tokensByName.set(t.name, t);
      token = this.tokensByName.get(tokenName);
      if (!token) return null;
      this.createdByThisRun.add(token.id);
    }

    // Masked keys (A8wt**********h3Ov) need /key unmask. 4-attempt cap so we don't loop forever.
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

  /** Best-effort delete of run-created tokens. Pre-existing tokens are never touched. */
  async cleanup(): Promise<void> {
    if (this.createdByThisRun.size === 0) return;
    consola.info(
      `[${this.providerName}] deleting ${this.createdByThisRun.size} probe tokens`,
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

  /** UTF-8-safe truncation to fit 30-byte total (matching ensureTokens). */
  private tokenNameFor(groupName: string): string {
    const TOKEN_NAME_MAX_BYTES = 30;
    const suffix = `-${this.prefix}`;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const maxBytes = TOKEN_NAME_MAX_BYTES - encoder.encode(suffix).length;
    const encoded = encoder.encode(groupName);
    if (encoded.length <= maxBytes) return `${groupName}${suffix}`;
    // Walk back to a UTF-8 code-point boundary (continuation bytes have 10xxxxxx).
    let cut = maxBytes;
    while (cut > 0 && (encoded[cut]! & 0xc0) === 0x80) cut--;
    return `${decoder.decode(encoded.subarray(0, cut))}${suffix}`;
  }
}
