import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import consola from "consola";
import type { RuntimeConfig } from "@core/config";
import type { Channel } from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { VerdictStore } from "@core/infra/verdict-store";
import { logsDir } from "@core/infra/paths";
import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { t } from "@server/i18n";
import { countedErrors, fetchLaneStats, type LaneStat } from "./lane-stats";
import { writeDailyRollupIfDue } from "./lane-rollup";

type LaneGraderConfig = NonNullable<RuntimeConfig["laneGrader"]>;
export type ResolvedGrader = Required<LaneGraderConfig>;

const ENABLED = 1;
const MANUALLY_DISABLED = 2;
const LEDGER_OBJECT = "lane-quarantine.json";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Thresholds from replaying a week of marketplace traffic (2026-10-04..11):
// 54 of 66 bad lanes caught, half of them 4 hours after their first request.
export function resolveGrader(cfg: LaneGraderConfig): ResolvedGrader {
  return {
    providers: cfg.providers,
    dryRun: cfg.dryRun ?? true,
    inflationLive: cfg.inflationLive ?? true,
    windowHours: cfg.windowHours ?? 6,
    minRequests: cfg.minRequests ?? 20,
    minUsers: cfg.minUsers ?? 3,
    emptyRate: cfg.emptyRate ?? 0.08,
    emptyPeerMultiple: cfg.emptyPeerMultiple ?? 3,
    shortRate: cfg.shortRate ?? 0.15,
    shortPeerMultiple: cfg.shortPeerMultiple ?? 2,
    errorRate: cfg.errorRate ?? 0.3,
    errorPeerMultiple: cfg.errorPeerMultiple ?? 2,
    errorPeerMargin: cfg.errorPeerMargin ?? 0.1,
    quarantineHours: cfg.quarantineHours ?? 4,
    maxQuarantineHours: cfg.maxQuarantineHours ?? 24,
    strikeWindowDays: cfg.strikeWindowDays ?? 7,
    candidateStrikes: cfg.candidateStrikes ?? 3,
    maxShareOfModel: cfg.maxShareOfModel ?? 1 / 3,
    minLiveLanesPerModel: cfg.minLiveLanesPerModel ?? 2,
    maxPerTick: cfg.maxPerTick ?? 10,
    inflationMinRequests: cfg.inflationMinRequests ?? 3,
    inflationSpeedMultiple: cfg.inflationSpeedMultiple ?? 5,
    inflationMinTokensPerSecond: cfg.inflationMinTokensPerSecond ?? 300,
    inflationPromptPerCached: cfg.inflationPromptPerCached ?? 3,
    inflationPromptMultiple: cfg.inflationPromptMultiple ?? 2.5,
    paddingMinReplies: cfg.paddingMinReplies ?? 3,
    paddingShare: cfg.paddingShare ?? 0.2,
  };
}

const median = (xs: number[]): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  const hi = s.at(Math.floor(s.length / 2));
  const lo = s.at(Math.floor((s.length - 1) / 2));
  return hi === undefined || lo === undefined ? null : (hi + lo) / 2;
};

// A merchant that runs one request several times (or says it did) bills the sum:
// a7 1326-6286 billed 4x the input of the same conversation on other lanes and
// claimed 670 output tokens a second against 33. Speed alone is a fast host, so
// it takes speed and inflated input together, and only a handful of requests.
function inflationReason(
  s: LaneStat,
  others: readonly LaneStat[],
  g: ResolvedGrader,
): string | null {
  if (s.requests < g.inflationMinRequests || s.p50TokensPerSecond === null)
    return null;
  const peerSpeed = median(
    others.flatMap((o) =>
      o.p50TokensPerSecond === null ? [] : [o.p50TokensPerSecond],
    ),
  );
  if (
    peerSpeed === null ||
    s.p50TokensPerSecond < g.inflationMinTokensPerSecond ||
    s.p50TokensPerSecond < peerSpeed * g.inflationSpeedMultiple
  )
    return null;
  const peerRequests = others.reduce((n, o) => n + o.requests, 0);
  const peerPrompt =
    peerRequests > 0
      ? others.reduce((n, o) => n + o.avgPrompt * o.requests, 0) / peerRequests
      : 0;
  const perCached = s.promptPerCached;
  const promptInflated =
    peerPrompt > 0 && s.avgPrompt >= peerPrompt * g.inflationPromptMultiple;
  const speed = `${Math.round(s.p50TokensPerSecond)} tok/s vs ${Math.round(peerSpeed)}`;
  if (perCached !== null && perCached >= g.inflationPromptPerCached)
    return `usage inflation: ${speed}, input ${perCached.toFixed(1)}x its cached tokens`;
  if (promptInflated)
    return `usage inflation: ${speed}, input ${Math.round(s.avgPrompt)} vs ${Math.round(peerPrompt)}`;
  return null;
}

// A seller that bills output it never streamed: a token is at least about one
// byte of text, so a reply billing far more tokens than the bytes the gateway
// relayed is padded (a7 6714 billed 1,388 tokens for a 300 byte notice). Judged
// against the model's other lanes so a family that hides its thinking is not.
function paddingReason(
  s: LaneStat,
  others: readonly LaneStat[],
  g: ResolvedGrader,
): string | null {
  if (s.paddedOut < g.paddingMinReplies || s.measuredOut === 0) return null;
  const share = s.paddedOut / s.measuredOut;
  if (share < g.paddingShare) return null;
  const peerMeasured = others.reduce((n, o) => n + o.measuredOut, 0);
  const peerPadded = others.reduce((n, o) => n + o.paddedOut, 0);
  const peerShare = peerMeasured > 0 ? peerPadded / peerMeasured : 0;
  if (peerShare * 4 > share) return null;
  return `padded output: ${s.paddedOut} of ${s.measuredOut} replies billed over twice the bytes streamed, peers ${pct(peerShare)}`;
}

export interface PeerRates {
  empty: number;
  short: number;
  error: number;
  lanes: number;
}

export interface Judgement {
  channel: Channel;
  stat: LaneStat;
  peers: PeerRates;
  reasons: string[];
  /** Billing fraud rather than quality: acts even while dryRun holds the rest. */
  fraud?: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** `providers` names channel tags; `*` grades every lane. */
export const inScope = (providers: readonly string[], ch: Channel): boolean =>
  providers.includes("*") || providers.includes(ch.tag ?? "");

function peerRates(stats: readonly LaneStat[]): PeerRates {
  const n = stats.reduce((s, x) => s + x.requests, 0);
  if (n === 0) return { empty: 0, short: 0, error: 0, lanes: 0 };
  return {
    empty: stats.reduce((s, x) => s + x.emptyOk, 0) / n,
    short: stats.reduce((s, x) => s + x.shortOk, 0) / n,
    error: stats.reduce((s, x) => s + countedErrors(x), 0) / n,
    lanes: stats.length,
  };
}

/**
 * Lanes in scope whose traffic stands out against every other lane of the same
 * model in the same window. A model failing on every lane is the model, not a
 * lane, so nothing is flagged without peers to compare against.
 */
export function judgeLanes(
  stats: readonly LaneStat[],
  channels: readonly Channel[],
  g: ResolvedGrader,
): Judgement[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const byModel = new Map<string, LaneStat[]>();
  for (const s of stats)
    byModel.set(s.model, [...(byModel.get(s.model) ?? []), s]);
  const out: Judgement[] = [];
  for (const s of stats) {
    const ch = byId.get(s.channelId);
    if (!ch || ch.status !== ENABLED || !inScope(g.providers, ch)) continue;
    const others = (byModel.get(s.model) ?? []).filter(
      (o) => o.channelId !== s.channelId,
    );
    if (others.length === 0) continue;
    const peers = peerRates(others);
    const fraud = [
      inflationReason(s, others, g),
      paddingReason(s, others, g),
    ].filter((r): r is string => r !== null);
    if (fraud.length > 0) {
      out.push({ channel: ch, stat: s, peers, reasons: fraud, fraud: true });
      continue;
    }
    if (s.requests < g.minRequests || s.users < g.minUsers) continue;
    const empty = s.emptyOk / s.requests;
    const short = s.shortOk / s.requests;
    const error = countedErrors(s) / s.requests;
    const reasons: string[] = [];
    if (empty >= g.emptyRate && empty > peers.empty * g.emptyPeerMultiple)
      reasons.push(`empty ${pct(empty)} vs ${pct(peers.empty)}`);
    if (short >= g.shortRate && short > peers.short * g.shortPeerMultiple)
      reasons.push(`short ${pct(short)} vs ${pct(peers.short)}`);
    if (
      error >= g.errorRate &&
      error > peers.error * g.errorPeerMultiple + g.errorPeerMargin
    )
      reasons.push(`errors ${pct(error)} vs ${pct(peers.error)}`);
    if (reasons.length > 0) out.push({ channel: ch, stat: s, peers, reasons });
  }
  return out;
}

export interface QuarantineEntry {
  channelId: number;
  name: string;
  provider: string;
  model: string;
  reason: string;
  since: string;
  until: string;
  strike: number;
}

export interface QuarantineLedger {
  active: QuarantineEntry[];
  /** Lane name to the start of every quarantine inside the strike window. */
  strikes: Record<string, string[]>;
}

const emptyLedger = (): QuarantineLedger => ({ active: [], strikes: {} });
const ledgerPath = () => join(logsDir(), LEDGER_OBJECT);

function parseLedger(raw: unknown): QuarantineLedger | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r: Record<string, unknown> = { ...raw };
  if (
    !Array.isArray(r.active) ||
    typeof r.strikes !== "object" ||
    r.strikes === null
  )
    return null;
  const active = r.active.filter(
    (e): e is QuarantineEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof e.channelId === "number" &&
      typeof e.until === "string",
  );
  const strikes: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(r.strikes))
    if (Array.isArray(v)) strikes[k] = v.filter((x) => typeof x === "string");
  return { active, strikes };
}

// The store is the shared truth (the cluster PVC can move nodes); the local
// file only covers a run without a store.
async function loadLedger(
  store: VerdictStore | null,
): Promise<QuarantineLedger> {
  if (store) {
    const text = await store.readText(LEDGER_OBJECT);
    const parsed = text ? parseLedger(JSON.parse(text)) : null;
    if (parsed) return parsed;
  }
  return parseLedger(readJson(ledgerPath())) ?? emptyLedger();
}

async function saveLedger(
  store: VerdictStore | null,
  ledger: QuarantineLedger,
): Promise<void> {
  writeJsonAtomic(ledgerPath(), ledger, { pretty: true });
  if (store)
    await store.writeText(
      LEDGER_OBJECT,
      JSON.stringify(ledger, null, 1),
      "application/json",
    );
}

type Decision = {
  at: string;
  dryRun: boolean;
  action: "quarantine" | "would-quarantine" | "release" | "held-safety";
  channelId: number;
  name: string;
  provider: string;
  model: string;
  reason: string;
  until?: string;
  strike?: number;
  stat?: LaneStat;
  peers?: PeerRates;
};

async function recordDecisions(
  store: VerdictStore | null,
  decisions: readonly Decision[],
): Promise<void> {
  if (decisions.length === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const lines = decisions.map((d) => JSON.stringify(d));
  const dir = join(logsDir(), "lane-grader");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${day}.jsonl`), lines.join("\n") + "\n");
  if (store)
    await store.appendText(
      `lane-grader/${day}.jsonl`,
      lines,
      "application/x-ndjson",
    );
}

const firstModel = (ch: Channel) => ch.models.split(",")[0]?.trim() ?? "";

export interface GradeResult {
  graded: number;
  flagged: number;
  quarantined: number;
  held: number;
  released: number;
  candidates: string[];
}

/**
 * One grader tick: release expired quarantines, grade the window, quarantine
 * the clear outliers within the per-model safety limits, write the daily
 * rollup once per UTC day. Status 2 because the gateway's own tester re-enables
 * a status 3 lane as soon as its harmless test prompt passes.
 */
export async function gradeLanes(
  target: NewApiClient,
  config: RuntimeConfig,
): Promise<GradeResult | null> {
  if (!config.laneGrader || !config.targetDb) return null;
  const g = resolveGrader(config.laneGrader);
  const store = config.verdictStore
    ? new VerdictStore(config.verdictStore)
    : null;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const result: GradeResult = {
    graded: 0,
    flagged: 0,
    quarantined: 0,
    held: 0,
    released: 0,
    candidates: [],
  };
  const decisions: Decision[] = [];
  const ledger = await loadLedger(store);
  let channels = await target.listChannels();
  const byId = new Map(channels.map((c) => [c.id, c]));

  const stillActive: QuarantineEntry[] = [];
  for (const e of ledger.active) {
    if (Date.parse(e.until) > now) {
      stillActive.push(e);
      continue;
    }
    const ch = byId.get(e.channelId);
    if (ch && ch.status === MANUALLY_DISABLED) {
      const ok = await target.updateChannel({ ...ch, status: ENABLED });
      if (!ok) {
        stillActive.push(e);
        consola.warn(t("CORE.LANE_GRADER.RELEASE_FAILED", { channel: e.name }));
        continue;
      }
      result.released++;
      consola.info(t("CORE.LANE_GRADER.RELEASED", { channel: e.name }));
    }
    decisions.push({
      at: nowIso,
      dryRun: false,
      action: "release",
      channelId: e.channelId,
      name: e.name,
      provider: e.provider,
      model: e.model,
      reason: e.reason,
    });
  }
  ledger.active = stillActive;
  if (result.released > 0) channels = await target.listChannels();

  const cutoff = now - g.strikeWindowDays * DAY_MS;
  for (const [name, starts] of Object.entries(ledger.strikes)) {
    const kept = starts.filter((s) => Date.parse(s) > cutoff);
    if (kept.length > 0) ledger.strikes[name] = kept;
    else delete ledger.strikes[name];
  }

  const stats = await fetchLaneStats(
    config.targetDb.url,
    (now - g.windowHours * HOUR_MS) / 1000,
    now / 1000,
  );
  result.graded = stats.filter((s) => {
    const ch = channels.find((c) => c.id === s.channelId);
    return !!ch && inScope(g.providers, ch) && ch.status === ENABLED;
  }).length;
  const quarantinedIds = new Set(ledger.active.map((e) => e.channelId));
  const flagged = judgeLanes(stats, channels, g)
    .filter((j) => !quarantinedIds.has(j.channel.id ?? -1))
    .sort(
      (a, b) =>
        b.stat.emptyOk +
        b.stat.shortOk +
        countedErrors(b.stat) -
        (a.stat.emptyOk + a.stat.shortOk + countedErrors(a.stat)),
    );
  result.flagged = flagged.length;

  const liveByModel = new Map<string, number>();
  for (const ch of channels)
    if (ch.status === ENABLED)
      liveByModel.set(
        firstModel(ch),
        (liveByModel.get(firstModel(ch)) ?? 0) + 1,
      );
  const outByModel = new Map<string, number>();
  for (const e of ledger.active)
    outByModel.set(e.model, (outByModel.get(e.model) ?? 0) + 1);

  let acted = 0;
  for (const j of flagged) {
    const ch = j.channel;
    const model = firstModel(ch);
    const live = liveByModel.get(model) ?? 0;
    const out = outByModel.get(model) ?? 0;
    const reason = j.reasons.join(", ");
    const dryRun = g.dryRun && !(j.fraud && g.inflationLive);
    const base = {
      at: nowIso,
      dryRun,
      channelId: ch.id ?? 0,
      name: ch.name,
      provider: ch.tag ?? "",
      model,
      reason,
      stat: j.stat,
      peers: j.peers,
    };
    if (
      acted >= g.maxPerTick ||
      live - 1 < g.minLiveLanesPerModel ||
      (out + 1) / (live + out) > g.maxShareOfModel
    ) {
      result.held++;
      decisions.push({ ...base, action: "held-safety" });
      consola.info(
        t("CORE.LANE_GRADER.HELD", { channel: ch.name, reason, live }),
      );
      continue;
    }
    const strike = (ledger.strikes[ch.name]?.length ?? 0) + 1;
    const hours = Math.min(
      g.quarantineHours * 2 ** (strike - 1),
      g.maxQuarantineHours,
    );
    const until = new Date(now + hours * HOUR_MS).toISOString();
    if (strike >= g.candidateStrikes) result.candidates.push(ch.name);
    if (dryRun) {
      decisions.push({ ...base, action: "would-quarantine", until, strike });
      consola.info(
        t("CORE.LANE_GRADER.WOULD_QUARANTINE", {
          channel: ch.name,
          reason,
          hours,
          strike,
        }),
      );
      acted++;
      continue;
    }
    const ok = await target.updateChannel({ ...ch, status: MANUALLY_DISABLED });
    if (!ok) {
      consola.warn(
        t("CORE.LANE_GRADER.QUARANTINE_FAILED", { channel: ch.name }),
      );
      continue;
    }
    acted++;
    result.quarantined++;
    liveByModel.set(model, live - 1);
    outByModel.set(model, out + 1);
    ledger.active.push({
      channelId: ch.id ?? 0,
      name: ch.name,
      provider: ch.tag ?? "",
      model,
      reason,
      since: nowIso,
      until,
      strike,
    });
    ledger.strikes[ch.name] = [...(ledger.strikes[ch.name] ?? []), nowIso];
    decisions.push({ ...base, action: "quarantine", until, strike });
    consola.warn(
      t("CORE.LANE_GRADER.QUARANTINED", {
        channel: ch.name,
        reason,
        hours,
        strike,
      }),
    );
  }
  for (const name of result.candidates)
    consola.warn(
      t("CORE.LANE_GRADER.CANDIDATE", {
        channel: name,
        strikes: ledger.strikes[name]?.length ?? g.candidateStrikes,
      }),
    );

  await recordDecisions(store, decisions);
  await saveLedger(store, ledger);
  await writeDailyRollupIfDue(config.targetDb.url, channels, ledger, store);
  consola.info(
    t("CORE.LANE_GRADER.SUMMARY", {
      ...result,
      candidates: result.candidates.length,
      mode: g.dryRun ? "dry-run" : "live",
    }),
  );
  return result;
}
