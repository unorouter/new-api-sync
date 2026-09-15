import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { logsDir } from "@core/infra/paths";
import { consola } from "consola";
import { join } from "path";
import { t } from "@server/i18n";
import type { VerdictStore } from "@core/infra/verdict-store";
import { hostOf } from "@core/infra/concurrency";

// ONE verdict file for every model+group pair: general test verdicts
// (http/stream/tool) AND claude authenticity. Key: `${provider}|${model}` (same
// shape as runner's passingByKey/blacklistKey). Every verdict ages out on its
// own clock (the TTL constants below): passes are retested several times a
// day, fails once a day. First load migrates the legacy authenticity-cache.json
// and authenticity-blacklist.json.
export type AuthenticityVerdict = "pass" | "fail";

export interface VerdictEntry {
  key: string;
  success?: boolean;
  streamSuccess?: boolean | null;
  toolCallSuccess?: boolean | null;
  toolParallel?: boolean | null;
  authenticity?: AuthenticityVerdict;
  authenticityReason?: string;
  // Input-token delta for the verifier's fixed text, deterministic per lane;
  // a change between probes means the backend changed whatever the reply says.
  tokenizerDelta?: number;
  // Timestamp of the last pass. A pass expires (AUTHENTICITY_PASS_TTL_HOURS)
  // because a merchant swaps its backend after the probe (a7 383 went from opus
  // to haiku 20 hours after a clean probe).
  verifiedAt?: string;
  // Timestamp of the last authenticity fail. Blacklists the lane for
  // AUTHENTICITY_FAIL_TTL_HOURS, then one probe decides again: a merchant that
  // fixed its backend comes back, one still faking is failed again for a day.
  authFailedAt?: string;
  // Date of the last functional pass (http/stream/tool). Expires after
  // TEST_PASS_TTL_DAYS plus a per-key jitter so the fleet retests spread out.
  testedAt?: string;
  // Last functional fail; skips the probe for TEST_FAIL_TTL_HOURS so a dead
  // merchant costs one key, pin and probe a day instead of one per run.
  failedAt?: string;
  // Fail came from a 429, 5xx or timeout: retried after TEST_FAIL_TRANSIENT_TTL_HOURS.
  failTransient?: boolean;
  // A fail withdrawn by clearTestFail. Stamped so the merge does not resurrect
  // the store's copy of the fail, whose failedAt would otherwise be newest.
  failClearedAt?: string;
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

export const TEST_FAIL_TTL_HOURS = 24;
export const TEST_FAIL_TRANSIENT_TTL_HOURS = 2;

export function isTestFailFresh(entry: VerdictEntry | undefined): boolean {
  if (!entry?.failedAt || entry.success) return false;
  const hours = entry.failTransient
    ? TEST_FAIL_TRANSIENT_TTL_HOURS
    : TEST_FAIL_TTL_HOURS;
  return Date.now() - Date.parse(entry.failedAt) < hours * 60 * 60 * 1000;
}

export function isTestPassFresh(entry: VerdictEntry | undefined): boolean {
  if (!entry?.success || !entry.testedAt) return false;
  return (
    Date.now() - Date.parse(entry.testedAt) < testTtlDays(entry.key) * DAY_MS
  );
}

const stampOf = (e: VerdictEntry): string =>
  [
    e.testedAt ?? "",
    e.verifiedAt ?? "",
    e.failedAt ?? "",
    e.failClearedAt ?? "",
    e.authFailedAt ?? "",
    e.since,
  ]
    .sort()
    .at(-1) ?? "";

// Union by key, newest stamp wins; an authenticity fail on either side survives
// while it is fresh (isAuthenticityFailFresh), so a pass recorded elsewhere in
// the same day cannot launder a faker.
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
    if (
      loser.authenticity === "fail" &&
      winner.authenticity !== "fail" &&
      isAuthenticityFailFresh(loser)
    ) {
      winner.authenticity = "fail";
      winner.authenticityReason = loser.authenticityReason;
      winner.authFailedAt = loser.authFailedAt;
      delete winner.verifiedAt;
    }
    out.set(e.key, winner);
  }
  return [...out.values()].sort((x, y) => (x.key < y.key ? -1 : 1));
}

export const AUTHENTICITY_PASS_TTL_HOURS = 12;

// Per-upstream override (provider authenticityPassTtlHours), keyed by host.
const authenticityPassTtlByHost = new Map<string, number>();

export function setAuthenticityPassTtlByHost(
  entries: Map<string, number>,
): void {
  authenticityPassTtlByHost.clear();
  for (const [url, hours] of entries)
    authenticityPassTtlByHost.set(hostOf(url), hours);
}

export function authenticityPassTtlHours(baseUrl?: string): number {
  if (!baseUrl) return AUTHENTICITY_PASS_TTL_HOURS;
  return (
    authenticityPassTtlByHost.get(hostOf(baseUrl)) ??
    AUTHENTICITY_PASS_TTL_HOURS
  );
}

export const AUTHENTICITY_FAIL_TTL_HOURS = 24;

// Entries from before authFailedAt existed carry only the fail date in
// `since`; that date counts as the fail time so they expire the same way.
export function isAuthenticityFailFresh(
  entry: VerdictEntry | undefined,
): boolean {
  if (entry?.authenticity !== "fail") return false;
  const at = Date.parse(entry.authFailedAt ?? entry.since);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at < AUTHENTICITY_FAIL_TTL_HOURS * 60 * 60 * 1000;
}

export function isAuthenticityPassFresh(
  entry: VerdictEntry | undefined,
  baseUrl?: string,
): boolean {
  if (entry?.authenticity !== "pass" || !entry.verifiedAt) return false;
  const age = Date.now() - Date.parse(entry.verifiedAt);
  return age < authenticityPassTtlHours(baseUrl) * 60 * 60 * 1000;
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
// Lines already in the local file but not yet in the store: a local-only flush
// (saveVerdictCache) must not empty the queue the next store push drains.
const unpushedHistory: string[] = [];

function historyPath(): string {
  return join(logsDir(), VERDICT_HISTORY_FILE);
}

export async function flushVerdictHistory(store?: VerdictStore): Promise<void> {
  if (pendingHistory.length > 0) {
    const lines = pendingHistory.map((e) => JSON.stringify(e));
    pendingHistory.length = 0;
    mkdirSync(dirname(historyPath()), { recursive: true });
    appendFileSync(historyPath(), lines.join("\n") + "\n");
    unpushedHistory.push(...lines);
  }
  if (!store || unpushedHistory.length === 0) return;
  const lines = unpushedHistory.splice(0);
  try {
    await store.appendHistory(lines);
  } catch (err) {
    unpushedHistory.unshift(...lines);
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
let activeStore: VerdictStore | null = null;
let inflightPush: Promise<void> | null = null;
let lastPushAt = 0;

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
  activeStore = store ?? null;
  lastPushAt = Date.now();
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
// Pushes are serialised: two interleaved read-merge-write cycles on the same
// object would drop each other's entries.
export async function pushVerdictCache(store: VerdictStore): Promise<void> {
  if (inflightPush) return inflightPush;
  inflightPush = pushOnce(store).finally(() => {
    inflightPush = null;
  });
  return inflightPush;
}

async function pushOnce(store: VerdictStore): Promise<void> {
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
    // Probes kept recording during the round trips; fold them in before the
    // refill, synchronously, so nothing recorded meanwhile is dropped.
    const final = mergeVerdicts(merged, [...cache.values()]);
    cache.clear();
    for (const e of final) cache.set(e.key, e);
    writeJsonAtomic(cachePath(), final);
    lastPushAt = Date.now();
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

// Every verdict write lands on disk at once and in the store at most every
// interval, so a run killed at any point (Job deadline, OOM, Ctrl-C) keeps
// what it probed: the next run loads the local file before merging the store.
const PUSH_MIN_INTERVAL_MS = 2 * 60 * 1000;

function persist(): void {
  saveVerdictCache();
  if (!activeStore || inflightPush) return;
  if (Date.now() - lastPushAt < PUSH_MIN_INTERVAL_MS) return;
  void pushVerdictCache(activeStore);
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
  transientFail?: boolean;
}): void {
  const prior = cache.get(opts.key);
  const entry: VerdictEntry = prior ?? { key: opts.key, since: today() };
  if (opts.success) {
    entry.success = true;
    entry.streamSuccess = opts.streamSuccess;
    entry.since = today();
    entry.testedAt = today();
    delete entry.failedAt;
    delete entry.failTransient;
  } else {
    delete entry.success;
    delete entry.streamSuccess;
    entry.failedAt = new Date().toISOString();
    delete entry.failClearedAt;
    if (opts.transientFail) entry.failTransient = true;
    else delete entry.failTransient;
  }
  if (opts.toolFresh && opts.toolCallSuccess !== null) {
    entry.toolCallSuccess = opts.toolCallSuccess;
    entry.toolParallel = opts.toolParallel;
  }
  const hasEvidence =
    entry.success !== undefined ||
    entry.failedAt !== undefined ||
    entry.toolCallSuccess !== undefined ||
    entry.authenticity !== undefined;
  if (hasEvidence) cache.set(opts.key, entry);
  else cache.delete(opts.key);
  persist();
}

// A fail caused by a stale cached lane key is not a merchant verdict; the
// caller re-keys and re-probes, and that probe records the real outcome.
export function clearTestFail(key: string): void {
  const entry = cache.get(key);
  if (!entry?.failedAt) return;
  delete entry.failedAt;
  delete entry.failTransient;
  entry.failClearedAt = new Date().toISOString();
  persist();
}

export function recordTokenizerDelta(key: string, delta: number): void {
  const entry: VerdictEntry = cache.get(key) ?? { key, since: today() };
  entry.tokenizerDelta = delta;
  cache.set(key, entry);
  persist();
}

export function setAuthenticityVerdict(
  key: string,
  verdict: AuthenticityVerdict,
  reason: string,
): void {
  const prior = cache.get(key);
  // A pass cannot overturn a fail that is still inside its day; once the fail
  // has aged out, the probe that produced this pass is the retest.
  const applied = !(verdict === "pass" && isAuthenticityFailFresh(prior));
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
  if (verdict === "fail") {
    entry.since = today();
    entry.authFailedAt = new Date().toISOString();
    delete entry.verifiedAt;
  } else {
    entry.verifiedAt = new Date().toISOString();
    delete entry.authFailedAt;
  }
  cache.set(key, entry);
  persist();
}
