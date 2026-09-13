import { logsDir } from "@core/infra/paths";
import type { VerdictStore } from "@core/infra/verdict-store";
import { t } from "@server/i18n";
import { consola } from "consola";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { UpstreamLogRow } from "./types";

// Only the matcher's fields are kept: the raw row carries the upstream's
// `other` json and content, ten times the size, and the cache holds a week.
export const compactUpstreamRow = (r: UpstreamLogRow): UpstreamLogRow => ({
  id: r.id,
  created_at: r.created_at,
  type: r.type,
  model_name: r.model_name,
  quota: r.quota,
  prompt_tokens: r.prompt_tokens,
  completion_tokens: r.completion_tokens,
  token_name: r.token_name,
  ...(r.token_id !== undefined ? { token_id: r.token_id } : {}),
  ...(r.request_id ? { request_id: r.request_id } : {}),
  ...(r.channel !== undefined ? { channel: r.channel } : {}),
  ...(r.use_time !== undefined ? { use_time: r.use_time } : {}),
  ...(r.ip ? { ip: r.ip } : {}),
  ...(userAgentOf(r) ? { user_agent: userAgentOf(r) } : {}),
});

// Relays that log the client put it in `other` (fish: user_agent); a cached
// row already carries it flat.
function userAgentOf(r: UpstreamLogRow): string | undefined {
  if (r.user_agent) return r.user_agent;
  if (!r.other) return undefined;
  try {
    const o: unknown = JSON.parse(r.other);
    if (o && typeof o === "object") {
      const ua = (o as { user_agent?: unknown }).user_agent;
      if (typeof ua === "string" && ua) return ua.slice(0, 200);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const CACHE_RETENTION_SECONDS = 45 * 24 * 3600;
const DIR = "reconcile-cache";

export interface UpstreamCache {
  provider: string;
  // Every second up to `coveredUntil` since `coveredFrom` has been fetched.
  coveredFrom: number | null;
  coveredUntil: number | null;
  rows: Map<number, UpstreamLogRow>;
}

const localPath = (provider: string) =>
  join(logsDir(), DIR, `${provider}.jsonl`);
const objectName = (provider: string) => `${DIR}/${provider}.jsonl`;

// First line is the cursor, the rest one row per line.
function parse(provider: string, text: string): UpstreamCache {
  const cache: UpstreamCache = {
    provider,
    coveredFrom: null,
    coveredUntil: null,
    rows: new Map(),
  };
  const lines = text.split("\n").filter((l) => l.length > 0);
  const head = lines.shift();
  if (head) {
    const cursor: unknown = JSON.parse(head);
    if (cursor && typeof cursor === "object") {
      const c = cursor as { from?: unknown; until?: unknown };
      if (typeof c.from === "number") cache.coveredFrom = c.from;
      if (typeof c.until === "number") cache.coveredUntil = c.until;
    }
  }
  for (const line of lines) {
    const row: unknown = JSON.parse(line);
    if (
      row &&
      typeof row === "object" &&
      typeof (row as UpstreamLogRow).id === "number"
    )
      cache.rows.set(
        (row as UpstreamLogRow).id,
        compactUpstreamRow(row as UpstreamLogRow),
      );
  }
  return cache;
}

function serialize(cache: UpstreamCache): string {
  const cutoff = Math.floor(Date.now() / 1000) - CACHE_RETENTION_SECONDS;
  const kept = [...cache.rows.values()]
    .filter((r) => r.created_at >= cutoff)
    .sort((a, b) => a.created_at - b.created_at);
  const from =
    cache.coveredFrom === null ? null : Math.max(cache.coveredFrom, cutoff);
  const head = JSON.stringify({ from, until: cache.coveredUntil });
  return [head, ...kept.map((r) => JSON.stringify(r))].join("\n") + "\n";
}

// Local file first, then the store copy if it covers more; both are the same
// shape so a fresh machine starts from whatever the last run pushed.
export async function loadUpstreamCache(
  provider: string,
  store: VerdictStore | null,
): Promise<UpstreamCache> {
  let cache: UpstreamCache = {
    provider,
    coveredFrom: null,
    coveredUntil: null,
    rows: new Map(),
  };
  const path = localPath(provider);
  if (existsSync(path)) cache = parse(provider, readFileSync(path, "utf8"));
  if (!store) return cache;
  try {
    const remote = await store.readText(objectName(provider));
    if (remote) {
      const r = parse(provider, remote);
      if ((r.coveredUntil ?? 0) > (cache.coveredUntil ?? 0)) {
        for (const [id, row] of cache.rows) r.rows.set(id, row);
        cache = r;
      } else for (const [id, row] of r.rows) cache.rows.set(id, row);
    }
  } catch (err) {
    consola.warn(
      t("CLI.RECONCILE.CACHE_PULL_FAILED", {
        name: provider,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return cache;
}

export async function saveUpstreamCache(
  cache: UpstreamCache,
  store: VerdictStore | null,
  opts?: { remote?: boolean },
): Promise<void> {
  const body = serialize(cache);
  mkdirSync(join(logsDir(), DIR), { recursive: true });
  writeFileSync(localPath(cache.provider), body);
  if (!store || opts?.remote === false) return;
  try {
    await store.writeText(
      objectName(cache.provider),
      body,
      "application/x-ndjson",
    );
  } catch (err) {
    consola.warn(
      t("CLI.RECONCILE.CACHE_PUSH_FAILED", {
        name: cache.provider,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

// The part of the window the cache does not cover yet. A gap before
// coveredFrom is fetched whole; the common case is only the tail.
export function uncoveredRange(
  cache: UpstreamCache,
  window: { start: number; end: number },
): { start: number; end: number } | null {
  if (cache.coveredFrom === null || cache.coveredUntil === null) return window;
  if (window.start < cache.coveredFrom) return window;
  if (window.end <= cache.coveredUntil) return null;
  return { start: cache.coveredUntil, end: window.end };
}

// Upstreams write their log after the response lands, so the last minutes of
// a fetch are refetched next time instead of being marked covered.
const LOG_LAG_SECONDS = 300;

export function extendCoverage(
  cache: UpstreamCache,
  fetched: { start: number; end: number },
  rows: UpstreamLogRow[],
): void {
  for (const r of rows) cache.rows.set(r.id, r);
  const until = fetched.end - LOG_LAG_SECONDS;
  if (until <= fetched.start) return;
  if (
    cache.coveredFrom === null ||
    cache.coveredUntil === null ||
    fetched.start < cache.coveredFrom
  )
    cache.coveredFrom = fetched.start;
  cache.coveredUntil = Math.max(cache.coveredUntil ?? 0, until);
}

export function rowsInWindow(
  cache: UpstreamCache,
  window: { start: number; end: number },
): UpstreamLogRow[] {
  const out: UpstreamLogRow[] = [];
  for (const r of cache.rows.values())
    if (r.created_at >= window.start && r.created_at <= window.end) out.push(r);
  return out;
}
