import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { appendFileSync } from "fs";
import { logsDir } from "@core/infra/paths";
import { consola } from "consola";
import { join } from "path";
import { t } from "@server/i18n";
import type { VerdictStore } from "@core/infra/verdict-store";

// ONE universal PERMANENT verdict file for every model+group pair: general test
// verdicts (http/stream/tool) AND claude authenticity. Key: `${provider}|${model}`
// (same shape as runner's passingByKey/blacklistKey). No TTLs: an entry is trusted
// until MANUALLY deleted from logs/verdict-cache.json. Never stored: http/stream
// failures (a failing pair re-probes every run until it passes) and transient tool
// outcomes. First load migrates the legacy authenticity-cache.json / -blacklist.json.
export type AuthenticityVerdict = "pass" | "fail";

export interface VerdictEntry {
  key: string;
  success?: boolean;
  streamSuccess?: boolean | null;
  toolCallSuccess?: boolean | null;
  toolParallel?: boolean | null;
  authenticity?: AuthenticityVerdict;
  authenticityReason?: string;
  // Timestamp of the last pass. A pass expires (AUTHENTICITY_PASS_TTL_HOURS)
  // because a merchant swaps its backend after the probe (a7 383 went from opus
  // to haiku 20 hours after a clean probe); a fail never expires.
  verifiedAt?: string;
  // Date of the last functional pass (http/stream/tool). Expires after
  // TEST_PASS_TTL_DAYS plus a per-key jitter so the fleet retests spread out.
  testedAt?: string;
  since: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const TEST_PASS_TTL_DAYS = 7;
const TEST_PASS_JITTER_DAYS = 2;

function keyHash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++)
    h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

function testTtlDays(key: string): number {
  const span = TEST_PASS_JITTER_DAYS * 2 + 1;
  return TEST_PASS_TTL_DAYS - TEST_PASS_JITTER_DAYS + (keyHash(key) % span);
}

export function isTestPassFresh(entry: VerdictEntry | undefined): boolean {
  if (!entry?.success || !entry.testedAt) return false;
  return (
    Date.now() - Date.parse(entry.testedAt) < testTtlDays(entry.key) * DAY_MS
  );
}

const stampOf = (e: VerdictEntry): string =>
  [e.testedAt ?? "", e.verifiedAt ?? "", e.since].sort().at(-1) ?? "";

// Union by key, newest stamp wins; an authenticity fail on either side survives
// (a fail never expires and is never overwritten by a pass).
export function mergeVerdicts(
  a: VerdictEntry[],
  b: VerdictEntry[],
): VerdictEntry[] {
  const out = new Map<string, VerdictEntry>();
  for (const e of [...a, ...b]) {
    const prior = out.get(e.key);
    if (!prior) {
      out.set(e.key, { ...e });
      continue;
    }
    const winner = stampOf(e) > stampOf(prior) ? { ...e } : prior;
    const loser = winner === prior ? e : prior;
    if (loser.authenticity === "fail" && winner.authenticity !== "fail") {
      winner.authenticity = "fail";
      winner.authenticityReason = loser.authenticityReason;
    }
    out.set(e.key, winner);
  }
  return [...out.values()].sort((x, y) => (x.key < y.key ? -1 : 1));
}

export const AUTHENTICITY_PASS_TTL_HOURS = 12;

export function isAuthenticityPassFresh(
  entry: VerdictEntry | undefined,
): boolean {
  if (entry?.authenticity !== "pass" || !entry.verifiedAt) return false;
  const age = Date.now() - Date.parse(entry.verifiedAt);
  return age < AUTHENTICITY_PASS_TTL_HOURS * 60 * 60 * 1000;
}

// Every authenticity outcome, applied or not, appended to logs/verdict-history.jsonl
// (and the store's copy). The cache keeps one row per key, so without this a
// merchant's earlier verdicts vanish the moment a new probe rewrites the row.
export interface VerdictHistoryEvent {
  key: string;
  at: string;
  verdict: AuthenticityVerdict;
  reason: string;
  prior: AuthenticityVerdict | null;
  priorReason: string;
  applied: boolean;
}

const VERDICT_HISTORY_FILE = "verdict-history.jsonl";
const pendingHistory: VerdictHistoryEvent[] = [];

function historyPath(): string {
  return join(logsDir(), VERDICT_HISTORY_FILE);
}

export async function flushVerdictHistory(store?: VerdictStore): Promise<void> {
  if (pendingHistory.length === 0) return;
  const lines = pendingHistory.map((e) => JSON.stringify(e));
  pendingHistory.length = 0;
  appendFileSync(historyPath(), lines.join("\n") + "\n");
  if (!store) return;
  try {
    await store.appendHistory(lines);
  } catch (err) {
    consola.warn(
      t("CORE.VERDICT_STORE.HISTORY_FAILED", {
        store: store.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

const VERDICT_CACHE_FILE = "verdict-cache.json";
const LEGACY_AUTH_CACHE_FILE = "authenticity-cache.json";
const LEGACY_BLACKLIST_FILE = "authenticity-blacklist.json";

const cache = new Map<string, VerdictEntry>();

const today = () => new Date().toISOString().slice(0, 10);
const cachePath = () => join(logsDir(), VERDICT_CACHE_FILE);

type LegacyAuthEntry = {
  key: string;
  verdict: string;
  since?: string;
  reason?: string;
};
type LegacyBlacklistEntry = { since: string; reason: string };
type LegacyBlacklist =
  | { rulesVersion?: number; entries: Record<string, LegacyBlacklistEntry> }
  | Record<string, LegacyBlacklistEntry>;

function migrateLegacyAuthenticity(): void {
  const authCache = readJson<LegacyAuthEntry[]>(
    join(logsDir(), LEGACY_AUTH_CACHE_FILE),
  );
  if (Array.isArray(authCache)) {
    for (const e of authCache)
      if (e && typeof e.key === "string")
        cache.set(e.key, {
          key: e.key,
          authenticity: e.verdict === "pass" ? "pass" : "fail",
          authenticityReason: e.reason ?? "",
          since: e.since ?? today(),
        });
    return;
  }
  const raw = readJson<LegacyBlacklist>(join(logsDir(), LEGACY_BLACKLIST_FILE));
  if (!raw) return;
  const entries =
    "entries" in raw && typeof raw.entries === "object"
      ? raw.entries
      : (raw as Record<string, LegacyBlacklistEntry>);
  for (const [key, val] of Object.entries(entries))
    if (val && typeof val.since === "string")
      cache.set(key, {
        key,
        authenticity: "fail",
        authenticityReason: val.reason ?? "",
        since: val.since,
      });
}

function loadLocal(): void {
  cache.clear();
  const raw = readJson<VerdictEntry[]>(cachePath());
  if (Array.isArray(raw)) {
    for (const e of raw)
      if (e && typeof e.key === "string") cache.set(e.key, e);
    return;
  }
  migrateLegacyAuthenticity();
}

// Passes recorded before testedAt existed get a synthetic date spread over the
// last TTL window, so the first run after the upgrade retests a slice of the
// fleet per night instead of all of it at once.
function backfillTestedAt(): void {
  const now = Date.now();
  for (const e of cache.values()) {
    if (!e.success || e.testedAt) continue;
    const ageDays = keyHash(e.key + ":backfill") % TEST_PASS_TTL_DAYS;
    e.testedAt = new Date(now - ageDays * DAY_MS).toISOString().slice(0, 10);
  }
}

export async function loadVerdictCache(store?: VerdictStore): Promise<void> {
  loadLocal();
  backfillTestedAt();
  if (!store) return;
  try {
    const remote = await store.fetchVerdicts();
    const entries = (remote ?? []).filter(
      (e): e is VerdictEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as VerdictEntry).key === "string",
    );
    const merged = mergeVerdicts([...cache.values()], entries);
    cache.clear();
    for (const e of merged) cache.set(e.key, e);
    consola.info(
      t("CORE.VERDICT_STORE.PULLED", {
        store: store.label,
        remote: entries.length,
        total: merged.length,
      }),
    );
  } catch (err) {
    consola.warn(
      t("CORE.VERDICT_STORE.PULL_FAILED", {
        store: store.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

// Re-read the object first so a run that finished elsewhere meanwhile is kept.
export async function pushVerdictCache(store: VerdictStore): Promise<void> {
  await flushVerdictHistory(store);
  try {
    const remote = ((await store.fetchVerdicts()) ?? []).filter(
      (e): e is VerdictEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as VerdictEntry).key === "string",
    );
    const merged = mergeVerdicts(remote, [...cache.values()]);
    await store.putVerdicts(merged);
    cache.clear();
    for (const e of merged) cache.set(e.key, e);
    writeJsonAtomic(cachePath(), merged);
    consola.info(
      t("CORE.VERDICT_STORE.PUSHED", {
        store: store.label,
        total: merged.length,
      }),
    );
  } catch (err) {
    consola.warn(
      t("CORE.VERDICT_STORE.PUSH_FAILED", {
        store: store.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export function saveVerdictCache(): void {
  if (cache.size === 0) return;
  writeJsonAtomic(cachePath(), [...cache.values()]);
  void flushVerdictHistory();
}

export const getVerdict = (key: string): VerdictEntry | undefined =>
  cache.get(key);

export function recordTestVerdict(opts: {
  key: string;
  success: boolean;
  streamSuccess: boolean | null;
  toolCallSuccess: boolean | null;
  toolParallel: boolean | null;
  /** False when the tool verdict was replayed from the cache (evidence not refreshed). */
  toolFresh: boolean;
}): void {
  const prior = cache.get(opts.key);
  const entry: VerdictEntry = prior ?? { key: opts.key, since: today() };
  if (opts.success) {
    entry.success = true;
    entry.streamSuccess = opts.streamSuccess;
    entry.since = today();
    entry.testedAt = today();
  } else {
    delete entry.success;
    delete entry.streamSuccess;
  }
  if (opts.toolFresh && opts.toolCallSuccess !== null) {
    entry.toolCallSuccess = opts.toolCallSuccess;
    entry.toolParallel = opts.toolParallel;
  }
  const hasEvidence =
    entry.success !== undefined ||
    entry.toolCallSuccess !== undefined ||
    entry.authenticity !== undefined;
  if (hasEvidence) cache.set(opts.key, entry);
  else cache.delete(opts.key);
}

export function setAuthenticityVerdict(
  key: string,
  verdict: AuthenticityVerdict,
  reason: string,
): void {
  const prior = cache.get(key);
  // Never overwrite a recorded failure with a pass (matches old blacklist semantics).
  const applied = !(verdict === "pass" && prior?.authenticity === "fail");
  pendingHistory.push({
    key,
    at: new Date().toISOString(),
    verdict,
    reason,
    prior: prior?.authenticity ?? null,
    priorReason: prior?.authenticityReason ?? "",
    applied,
  });
  if (!applied) return;
  const entry: VerdictEntry = prior ?? { key, since: today() };
  entry.authenticity = verdict;
  entry.authenticityReason = reason;
  if (verdict === "fail") entry.since = today();
  else entry.verifiedAt = new Date().toISOString();
  cache.set(key, entry);
}
