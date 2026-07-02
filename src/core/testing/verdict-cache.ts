import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import { join } from "path";

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
  since: string;
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

export function loadVerdictCache(): void {
  cache.clear();
  const raw = readJson<VerdictEntry[]>(cachePath());
  if (Array.isArray(raw)) {
    for (const e of raw)
      if (e && typeof e.key === "string") cache.set(e.key, e);
    return;
  }
  migrateLegacyAuthenticity();
}

export function saveVerdictCache(): void {
  if (cache.size === 0) return;
  writeJsonAtomic(cachePath(), [...cache.values()]);
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
  if (verdict === "pass" && prior?.authenticity === "fail") return;
  const entry: VerdictEntry = prior ?? { key, since: today() };
  entry.authenticity = verdict;
  entry.authenticityReason = reason;
  if (verdict === "fail") entry.since = today();
  cache.set(key, entry);
}
