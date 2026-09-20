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

export interface CoverageSegment {
  from: number;
  until: number;
}

export interface UpstreamCache {
  provider: string;
  // Sorted, non-overlapping ranges whose every second has been fetched.
  segments: CoverageSegment[];
  rows: Map<number, UpstreamLogRow>;
}

const isSegment = (v: unknown): v is CoverageSegment =>
  !!v &&
  typeof v === "object" &&
  typeof (v as CoverageSegment).from === "number" &&
  typeof (v as CoverageSegment).until === "number" &&
  (v as CoverageSegment).until > (v as CoverageSegment).from;

function mergeSegments(segments: CoverageSegment[]): CoverageSegment[] {
  const sorted = [...segments].sort((a, b) => a.from - b.from);
  const out: CoverageSegment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.until)
      last.until = Math.max(last.until, s.until);
    else out.push({ from: s.from, until: s.until });
  }
  return out;
}

const localPath = (provider: string) =>
  join(logsDir(), DIR, `${provider}.jsonl`);
const objectName = (provider: string) => `${DIR}/${provider}.jsonl`;

// First line is the cursor, the rest one row per line.
function parse(provider: string, text: string): UpstreamCache {
  const cache: UpstreamCache = { provider, segments: [], rows: new Map() };
  const lines = text.split("\n").filter((l) => l.length > 0);
  const head = lines.shift();
  if (head) {
    const cursor: unknown = JSON.parse(head);
    // The old single-range cursor merged disjoint fetches into one span, so
    // it is not trusted: rows are kept, coverage is rebuilt.
    if (cursor && typeof cursor === "object") {
      const c = cursor as { segments?: unknown };
      if (Array.isArray(c.segments))
        cache.segments = mergeSegments(c.segments.filter(isSegment));
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
  const segments = cache.segments.flatMap((s) =>
    s.until <= cutoff
      ? []
      : [{ from: Math.max(s.from, cutoff), until: s.until }],
  );
  const head = JSON.stringify({ segments });
  return [head, ...kept.map((r) => JSON.stringify(r))].join("\n") + "\n";
}

// Local file unioned with the store copy: both hold honest coverage, so a
// fresh machine starts from whatever the last run pushed.
export async function loadUpstreamCache(
  provider: string,
  store: VerdictStore | null,
): Promise<UpstreamCache> {
  let cache: UpstreamCache = { provider, segments: [], rows: new Map() };
  const path = localPath(provider);
  if (existsSync(path)) cache = parse(provider, readFileSync(path, "utf8"));
  if (!store) return cache;
  try {
    const remote = await store.readText(objectName(provider));
    if (remote) {
      const r = parse(provider, remote);
      for (const [id, row] of r.rows)
        if (!cache.rows.has(id)) cache.rows.set(id, row);
      cache.segments = mergeSegments([...cache.segments, ...r.segments]);
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

// The parts of the window no segment covers, in time order.
export function uncoveredRanges(
  cache: UpstreamCache,
  window: { start: number; end: number },
): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  let cursor = window.start;
  for (const s of cache.segments) {
    if (s.until <= cursor) continue;
    if (s.from >= window.end) break;
    if (s.from > cursor)
      gaps.push({ start: cursor, end: Math.min(s.from, window.end) });
    cursor = Math.max(cursor, s.until);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

// Upstreams write their log after the response lands, so the last minutes of
// a fetch that reaches the present are refetched next time instead of being
// marked covered. A window that ended earlier than that has settled: trimming
// it too left a five minute hole at every day boundary that every later run
// fetched again.
const LOG_LAG_SECONDS = 300;

export function extendCoverage(
  cache: UpstreamCache,
  fetched: { start: number; end: number },
  rows: UpstreamLogRow[],
): void {
  for (const r of rows) cache.rows.set(r.id, r);
  const settled = Math.floor(Date.now() / 1000) - LOG_LAG_SECONDS;
  const until = fetched.end > settled ? settled : fetched.end;
  if (until <= fetched.start) return;
  cache.segments = mergeSegments([
    ...cache.segments,
    { from: fetched.start, until },
  ]);
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
