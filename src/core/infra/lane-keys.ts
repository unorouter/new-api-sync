import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { logsDir } from "@core/infra/paths";
import type { VerdictStore } from "@core/infra/verdict-store";
import { t } from "@server/i18n";
import { consola } from "consola";

// Revealed upstream token secrets, keyed by provider and token id. A relay lists
// its tokens with the secret masked, so without this every run re-reveals every
// lane through the rate limited reveal endpoints (94 of a 108 minute a7 walk on
// 2026-09-14). Token ids are auto increment and never reused, so an id that is
// still listed still names the same secret; an id that vanished is pruned and a
// recreated token has a new id and is revealed once.
export interface LaneKeyEntry {
  id: number;
  name: string;
  key: string;
  revealedAt: string;
}

export interface LaneKeyStats {
  cached: number;
  revealed: number;
  evictedProbe: number;
  evictedGateway: number;
  rejected: number;
}

export type LaneKeyEvictionReason = "probe" | "gateway";

interface LaneKeyFile {
  tokens: LaneKeyEntry[];
  // Evicted ids with the eviction time: a store copy that still holds the
  // entry must not bring it back on the next read-merge-write.
  evicted: Record<string, string>;
}

const byProvider = new Map<string, Map<number, LaneKeyEntry>>();
const tombstones = new Map<string, Map<number, string>>();
const stats = new Map<string, LaneKeyStats>();
const dirty = new Set<string>();
let activeStore: VerdictStore | null = null;
let enabled = false;

const filePath = (provider: string) =>
  join(logsDir(), "lane-keys", `${provider}.json.enc`);

function entries(provider: string): Map<number, LaneKeyEntry> {
  let map = byProvider.get(provider);
  if (!map) byProvider.set(provider, (map = new Map()));
  return map;
}

function graves(provider: string): Map<number, string> {
  let map = tombstones.get(provider);
  if (!map) tombstones.set(provider, (map = new Map()));
  return map;
}

export function laneKeyStats(provider: string): LaneKeyStats {
  let s = stats.get(provider);
  if (!s)
    stats.set(
      provider,
      (s = {
        cached: 0,
        revealed: 0,
        evictedProbe: 0,
        evictedGateway: 0,
        rejected: 0,
      }),
    );
  return s;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function isEntry(v: unknown): v is LaneKeyEntry {
  return (
    isRecord(v) &&
    typeof v.id === "number" &&
    typeof v.name === "string" &&
    typeof v.key === "string" &&
    typeof v.revealedAt === "string"
  );
}

// JSON.parse boundary for the sealed file and the store object.
function parseFile(raw: unknown): LaneKeyFile {
  const out: LaneKeyFile = { tokens: [], evicted: {} };
  if (!isRecord(raw)) return out;
  if (Array.isArray(raw.tokens)) out.tokens = raw.tokens.filter(isEntry);
  if (isRecord(raw.evicted))
    for (const [id, at] of Object.entries(raw.evicted))
      if (typeof at === "string") out.evicted[id] = at;
  return out;
}

function mergeInto(provider: string, incoming: LaneKeyFile): void {
  const target = entries(provider);
  const dead = graves(provider);
  for (const [id, at] of Object.entries(incoming.evicted)) {
    const n = Number(id);
    const prior = dead.get(n);
    if (!prior || prior < at) dead.set(n, at);
  }
  for (const e of incoming.tokens) {
    const grave = dead.get(e.id);
    if (grave && grave >= e.revealedAt) continue;
    const prior = target.get(e.id);
    if (!prior || prior.revealedAt < e.revealedAt) target.set(e.id, e);
  }
  for (const [id, at] of dead) {
    const e = target.get(id);
    if (e && at >= e.revealedAt) target.delete(id);
  }
}

function currentFile(provider: string): LaneKeyFile {
  return {
    tokens: [...entries(provider).values()],
    evicted: Object.fromEntries(
      [...graves(provider)].map(([id, at]) => [String(id), at]),
    ),
  };
}

function readLocal(provider: string, store: VerdictStore): LaneKeyFile {
  const path = filePath(provider);
  if (!existsSync(path)) return { tokens: [], evicted: {} };
  try {
    return parseFile(JSON.parse(store.unsealText(readFileSync(path, "utf8"))));
  } catch {
    return { tokens: [], evicted: {} };
  }
}

function writeLocal(provider: string, store: VerdictStore): void {
  const path = filePath(provider);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, store.sealText(JSON.stringify(currentFile(provider))));
  renameSync(tmp, path);
}

// The cache only exists sealed: no cipher means no cache, never a plain file.
export async function loadLaneKeys(
  store: VerdictStore | undefined,
  providers: string[],
): Promise<void> {
  byProvider.clear();
  tombstones.clear();
  stats.clear();
  dirty.clear();
  activeStore = store ?? null;
  enabled = !!store && store.canHoldKeys;
  if (!enabled) {
    consola.info(t("CORE.LANE_KEYS.DISABLED_NO_CIPHER"));
    return;
  }
  for (const provider of providers) {
    const map = entries(provider);
    mergeInto(provider, readLocal(provider, store!));
    try {
      const remote = await store!.fetchLaneKeys(provider);
      if (remote) mergeInto(provider, parseFile(remote));
    } catch (err) {
      consola.warn(
        t("CORE.LANE_KEYS.PULL_FAILED", {
          provider,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (map.size > 0)
      consola.info(t("CORE.LANE_KEYS.LOADED", { provider, count: map.size }));
  }
}

export const laneKeysEnabled = (): boolean => enabled;

// A hit needs the listed name to match too: the id is authoritative, the name
// guards against a corrupted or hand edited file mapping an id to another lane.
export function getLaneKey(
  provider: string,
  id: number,
  name: string,
): string | undefined {
  if (!enabled) return undefined;
  const e = entries(provider).get(id);
  if (!e || e.name !== name) return undefined;
  laneKeyStats(provider).cached++;
  return e.key;
}

// `listed` is a key the relay returned unmasked in its token list: kept, but
// not a reveal, so it does not count as one.
export function putLaneKey(
  provider: string,
  id: number,
  name: string,
  key: string,
  source: "reveal" | "listed" = "reveal",
): void {
  if (!enabled) return;
  const map = entries(provider);
  const prior = map.get(id);
  if (prior && prior.key === key && prior.name === name) return;
  graves(provider).delete(id);
  map.set(id, { id, name, key, revealedAt: new Date().toISOString() });
  if (source === "reveal") laneKeyStats(provider).revealed++;
  dirty.add(provider);
}

export function evictLaneKey(
  provider: string,
  where: { id?: number; name?: string },
  reason: LaneKeyEvictionReason,
): boolean {
  if (!enabled) return false;
  const map = entries(provider);
  const dead = graves(provider);
  let removed = false;
  for (const [id, e] of map) {
    if ((where.id !== undefined && id === where.id) || e.name === where.name) {
      map.delete(id);
      dead.set(id, new Date().toISOString());
      removed = true;
    }
  }
  if (!removed) return false;
  const s = laneKeyStats(provider);
  if (reason === "probe") s.evictedProbe++;
  else s.evictedGateway++;
  dirty.add(provider);
  return true;
}

export function pruneLaneKeys(provider: string, liveIds: Set<number>): void {
  if (!enabled) return;
  const map = entries(provider);
  for (const id of [...map.keys()])
    if (!liveIds.has(id)) {
      map.delete(id);
      dirty.add(provider);
    }
  const dead = graves(provider);
  for (const id of [...dead.keys()])
    if (!liveIds.has(id)) {
      dead.delete(id);
      dirty.add(provider);
    }
}

// Local file on every flush; the store only when this run changed something,
// read first so a run that finished elsewhere meanwhile keeps its entries.
export async function flushLaneKeys(provider: string): Promise<void> {
  if (!enabled || !activeStore || !dirty.has(provider)) return;
  const store = activeStore;
  const map = entries(provider);
  writeLocal(provider, store);
  try {
    const remote = await store.fetchLaneKeys(provider);
    if (remote) mergeInto(provider, parseFile(remote));
    await store.putLaneKeys(provider, currentFile(provider));
    writeLocal(provider, store);
    dirty.delete(provider);
    consola.info(t("CORE.LANE_KEYS.PUSHED", { provider, count: map.size }));
  } catch (err) {
    consola.warn(
      t("CORE.LANE_KEYS.PUSH_FAILED", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function flushAllLaneKeys(): Promise<void> {
  for (const provider of [...dirty]) await flushLaneKeys(provider);
}
