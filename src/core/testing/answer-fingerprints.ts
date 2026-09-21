/**
 * Per lane ledger of what the ladder observed beyond the verdict: the answer
 * fingerprint of every run (arXiv 2607.10252, accumulated because one run is
 * 24 answers and says nothing), whether the identity probes named another
 * family, the injected wrapper size in prompt tokens, and the probe text the
 * style classifier reads. One record per run keyed by its stamp, so the
 * cluster and a local run merge by union and never double count.
 *
 * Judged in one pass before every store push: each lane's pooled fingerprint
 * against the profiles its family trusts (the maker's own route, each known
 * host, else the majority cluster), plus the two history notes. Every result
 * is a note; nothing here disables a lane.
 */

import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import type { VerdictStore } from "@core/infra/verdict-store";
import { t } from "@server/i18n";
import {
  compareToProfiles,
  fingerprintClusters,
  mergeFingerprints,
  type CompareOptions,
  type FingerprintSample,
  type ProfileVerdict,
} from "ai-model-verifier";
import { consola } from "consola";
import { join } from "path";
import { classifyStyle, trainStyleModel, type StyleModel, type StyleVerdict } from "./style-classifier";

const CACHE_FILE = "answer-fingerprints.json";
const SUMMARY_FILE = "answer-fingerprints-summary.json";
const STORE_OBJECT = "answer-fingerprints.json";
const STORE_SUMMARY = "answer-fingerprints/summary.json";
const KEEP_RUNS = 60;
const KEEP_DAYS = 30;
const HISTORY_WINDOW = 10;
const MIN_CLUSTER_LANES = 3;
const MIN_PROFILE_CELLS = 4;

export type FingerprintRun = {
  at: string;
  sample: FingerprintSample | null;
  /** identity or model-name named a family other than the requested maker. */
  foreign: boolean;
  /** Both identity probes produced a readable answer. */
  answered: boolean;
  /** `usage.prompt` of the creative probe: fixed text plus whatever the lane injects. */
  promptTokens: number | null;
  /** emotional, creative and self replies, for the style classifier. */
  text: string;
};

export type LaneSource = "official" | "host" | "market";

export type FingerprintEntry = {
  key: string;
  provider: string;
  model: string;
  family: string;
  maker: string | null;
  host: string;
  runs: FingerprintRun[];
  verdict?: ProfileVerdict;
  jsd?: number | null;
  against?: string | null;
  identityMix?: number | null;
  wrapperTokens?: number | null;
  styleMaker?: StyleVerdict | null;
  judgedAt?: string;
};

export type LaneHistory = Pick<
  FingerprintEntry,
  "verdict" | "jsd" | "against" | "identityMix" | "wrapperTokens" | "styleMaker" | "judgedAt"
> & { runs: number; samples: number };

export type FingerprintOptions = CompareOptions & { repeats?: number };

let options: FingerprintOptions = {};
export function setAnswerFingerprintOptions(cfg?: FingerprintOptions): void {
  options = cfg ?? {};
}
export const answerFingerprintRepeats = (): number => options.repeats ?? 3;

const entries = new Map<string, FingerprintEntry>();
const cachePath = () => join(logsDir(), CACHE_FILE);

const isEntry = (e: unknown): e is FingerprintEntry =>
  !!e &&
  typeof e === "object" &&
  typeof (e as FingerprintEntry).key === "string" &&
  Array.isArray((e as FingerprintEntry).runs);

function mergeEntries(a: FingerprintEntry, b: FingerprintEntry): FingerprintEntry {
  const byAt = new Map<string, FingerprintRun>();
  for (const r of [...a.runs, ...b.runs]) byAt.set(r.at, r);
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const runs = [...byAt.values()]
    .filter((r) => Date.parse(r.at) >= cutoff)
    .sort((x, y) => x.at.localeCompare(y.at))
    .slice(-KEEP_RUNS);
  const newer = (a.judgedAt ?? "") >= (b.judgedAt ?? "") ? a : b;
  return { ...b, ...a, ...pickJudgement(newer), runs };
}

const pickJudgement = (e: FingerprintEntry) => ({
  verdict: e.verdict,
  jsd: e.jsd,
  against: e.against,
  identityMix: e.identityMix,
  wrapperTokens: e.wrapperTokens,
  styleMaker: e.styleMaker,
  judgedAt: e.judgedAt,
});

function mergeAll(remote: FingerprintEntry[], local: FingerprintEntry[]): FingerprintEntry[] {
  const out = new Map<string, FingerprintEntry>();
  for (const e of remote) out.set(e.key, e);
  for (const e of local) {
    const prior = out.get(e.key);
    out.set(e.key, prior ? mergeEntries(e, prior) : e);
  }
  return [...out.values()];
}

export async function loadAnswerFingerprints(store?: VerdictStore): Promise<void> {
  entries.clear();
  const local = readJson<unknown>(cachePath());
  for (const e of (Array.isArray(local) ? local : []).filter(isEntry)) entries.set(e.key, e);
  if (!store) return;
  try {
    const text = await store.readText(STORE_OBJECT);
    const remote: unknown = text ? JSON.parse(text) : [];
    const merged = mergeAll(
      (Array.isArray(remote) ? remote : []).filter(isEntry),
      [...entries.values()],
    );
    entries.clear();
    for (const e of merged) entries.set(e.key, e);
  } catch (err) {
    consola.warn(
      t("CORE.FINGERPRINT.PULL_FAILED", {
        store: store.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export function recordFingerprintRun(opts: {
  key: string;
  provider: string;
  model: string;
  family: string;
  maker: string | null;
  host: string;
  run: FingerprintRun;
}): void {
  const prior = entries.get(opts.key);
  const fresh: FingerprintEntry = {
    key: opts.key,
    provider: opts.provider,
    model: opts.model,
    family: opts.family,
    maker: opts.maker,
    host: opts.host,
    runs: [opts.run],
  };
  entries.set(opts.key, prior ? mergeEntries(prior, fresh) : fresh);
}

export const pooledSample = (e: FingerprintEntry): FingerprintSample | null =>
  e.runs.reduce<FingerprintSample | null>(
    (acc, r) => (r.sample ? (acc ? mergeFingerprints(acc, r.sample) : r.sample) : acc),
    null,
  );

const validCells = (s: FingerprintSample | null, min: number): number =>
  s ? Object.values(s.cells).filter((c) => c.valid >= min).length : 0;

export function laneHistory(key: string): LaneHistory | null {
  const e = entries.get(key);
  if (!e) return null;
  const s = pooledSample(e);
  return {
    ...pickJudgement(e),
    runs: e.runs.length,
    samples: s ? Object.values(s.cells).reduce((a, c) => a + c.valid, 0) : 0,
  };
}

/** Which profile set a lane feeds: the maker's own route, a known host, or a market. */
export type SourceOf = (entry: FingerprintEntry) => { source: LaneSource; name: string };

export type FamilyProfile = { name: string; kind: LaneSource | "majority"; lanes: number; sample: FingerprintSample };

export function profilesFor(family: string, sourceOf: SourceOf): FamilyProfile[] {
  const min = options.minCellSamples ?? 10;
  const lanes = [...entries.values()].filter((e) => e.family === family);
  const pools = new Map<string, { kind: LaneSource; lanes: number; sample: FingerprintSample | null }>();
  for (const e of lanes) {
    const { source, name } = sourceOf(e);
    if (source === "market") continue;
    const label = source === "official" ? "official" : `host:${name}`;
    const s = pooledSample(e);
    const p = pools.get(label) ?? { kind: source, lanes: 0, sample: null };
    p.lanes++;
    if (s) p.sample = p.sample ? mergeFingerprints(p.sample, s) : s;
    pools.set(label, p);
  }
  const out: FamilyProfile[] = [];
  for (const [name, p] of pools)
    if (p.sample && validCells(p.sample, min) >= MIN_PROFILE_CELLS)
      out.push({ name, kind: p.kind, lanes: p.lanes, sample: p.sample });
  if (!out.some((p) => p.kind === "official")) {
    const samples: Record<string, FingerprintSample> = {};
    for (const e of lanes) {
      const s = pooledSample(e);
      if (s && validCells(s, min) >= MIN_PROFILE_CELLS) samples[e.key] = s;
    }
    const top = fingerprintClusters(samples, options.matchBits, options)[0];
    if (top && top.members.length >= MIN_CLUSTER_LANES)
      out.push({ name: "majority", kind: "majority", lanes: top.members.length, sample: top.pooled });
  }
  return out;
}

const median = (xs: number[]): number | null => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : null;
};

export type FamilySummary = {
  family: string;
  maker: string | null;
  profiles: { name: string; kind: string; lanes: number; validCells: number }[];
  baselinePromptTokens: number | null;
  lanes: {
    key: string;
    provider: string;
    runs: number;
    samples: number;
    verdict: ProfileVerdict | null;
    jsd: number | null;
    against: string | null;
    identityMix: number | null;
    wrapperTokens: number | null;
    styleMaker: StyleVerdict | null;
  }[];
};

export type FingerprintSummary = {
  judgedAt: string;
  lanes: number;
  style: { accuracy: number | null; classes: string[]; trained: number; emitted: boolean };
  families: FamilySummary[];
};

/**
 * One pass over every lane: pooled fingerprint against the family's profiles,
 * identity mix and wrapper size over the last runs, the style classifier's
 * posterior. Returns the summary that is written next to the cache.
 */
export function judgeAllLanes(sourceOf: SourceOf): FingerprintSummary {
  const now = new Date().toISOString();
  const all = [...entries.values()];
  const style: StyleModel | null = trainStyleModel(
    all
      .filter((e) => sourceOf(e).source === "official" && e.maker)
      .map((e) => ({ lane: e.key, label: e.maker!, texts: e.runs.map((r) => r.text) })),
  );
  const families = new Map<string, FingerprintEntry[]>();
  for (const e of all) (families.get(e.family) ?? families.set(e.family, []).get(e.family)!).push(e);
  const out: FamilySummary[] = [];
  for (const [family, lanes] of families) {
    const profiles = profilesFor(family, sourceOf);
    // The family's prompt token floor: its trusted lanes, else the least
    // wrapped lane, so a market-only family still ranks its wrappers.
    const trusted = median(
      lanes
        .filter((e) => sourceOf(e).source !== "market")
        .flatMap((e) => e.runs.map((r) => r.promptTokens ?? NaN)),
    );
    const laneMedians = lanes
      .map((e) => median(e.runs.map((r) => r.promptTokens ?? NaN)))
      .filter((m): m is number => m !== null);
    const baseline = trusted ?? (laneMedians.length ? Math.min(...laneMedians) : null);
    const rows: FamilySummary["lanes"] = [];
    for (const e of lanes) {
      const s = pooledSample(e);
      const cmp = s && profiles.length ? compareToProfiles(s, profiles, options) : null;
      const recent = e.runs.slice(-HISTORY_WINDOW);
      const answered = recent.filter((r) => r.answered);
      const identityMix = answered.length >= 3 ? answered.filter((r) => r.foreign).length / answered.length : null;
      const lanePrompt = median(recent.map((r) => r.promptTokens ?? NaN));
      const wrapperTokens = lanePrompt !== null && baseline !== null ? lanePrompt - baseline : null;
      const styleMaker = style && style.emitted ? classifyStyle(style, recent.map((r) => r.text)) : null;
      Object.assign(e, {
        verdict: cmp?.verdict ?? (s ? "insufficient" : undefined),
        jsd: cmp?.jsd ?? null,
        against: cmp?.best ?? null,
        identityMix,
        wrapperTokens,
        styleMaker,
        judgedAt: now,
      });
      rows.push({
        key: e.key,
        provider: e.provider,
        runs: e.runs.length,
        samples: s ? Object.values(s.cells).reduce((a, c) => a + c.valid, 0) : 0,
        verdict: e.verdict ?? null,
        jsd: e.jsd ?? null,
        against: e.against ?? null,
        identityMix,
        wrapperTokens,
        styleMaker,
      });
    }
    rows.sort((a, b) => (b.jsd ?? -1) - (a.jsd ?? -1));
    out.push({
      family,
      maker: lanes[0]?.maker ?? null,
      profiles: profiles.map((p) => ({
        name: p.name,
        kind: p.kind,
        lanes: p.lanes,
        validCells: validCells(p.sample, options.minCellSamples ?? 10),
      })),
      baselinePromptTokens: baseline,
      lanes: rows,
    });
  }
  out.sort((a, b) => b.lanes.length - a.lanes.length);
  return {
    judgedAt: now,
    lanes: all.length,
    style: {
      accuracy: style?.accuracy ?? null,
      classes: style?.classes ?? [],
      trained: style?.trained ?? 0,
      emitted: style?.emitted ?? false,
    },
    families: out,
  };
}

export function saveAnswerFingerprints(summary?: FingerprintSummary): void {
  writeJsonAtomic(cachePath(), [...entries.values()]);
  if (summary) writeJsonAtomic(join(logsDir(), SUMMARY_FILE), summary);
}

/** Judge, save locally, then union with the store copy and write both objects. */
export async function judgeAndPushAnswerFingerprints(
  sourceOf: SourceOf,
  store?: VerdictStore,
): Promise<FingerprintSummary> {
  const summary = judgeAllLanes(sourceOf);
  saveAnswerFingerprints(summary);
  if (!store) return summary;
  try {
    const text = await store.readText(STORE_OBJECT);
    const remote: unknown = text ? JSON.parse(text) : [];
    const merged = mergeAll(
      (Array.isArray(remote) ? remote : []).filter(isEntry),
      [...entries.values()],
    );
    await store.writeText(STORE_OBJECT, JSON.stringify(merged), "application/json");
    await store.writeText(STORE_SUMMARY, JSON.stringify(summary), "application/json");
    entries.clear();
    for (const e of merged) entries.set(e.key, e);
    writeJsonAtomic(cachePath(), merged);
  } catch (err) {
    consola.warn(
      t("CORE.FINGERPRINT.PUSH_FAILED", {
        store: store.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return summary;
}

export const readFingerprintSummary = (): FingerprintSummary | null =>
  readJson<FingerprintSummary>(join(logsDir(), SUMMARY_FILE));

const fmt = (n: number | null | undefined, digits = 2): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";

export function printFingerprintSummary(
  summary: FingerprintSummary,
  familyGlob?: string,
): void {
  // Families are normalised ids (dots to hyphens), so the glob is too.
  const re = familyGlob
    ? new RegExp(
        `^${familyGlob
          .toLowerCase()
          .replace(/[._]/g, "-")
          .replace(/[+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")}$`,
      )
    : null;
  consola.info(t("CLI.FINGERPRINTS.HEADER", { lanes: summary.lanes, judgedAt: summary.judgedAt }));
  consola.info(
    t("CLI.FINGERPRINTS.STYLE", {
      classes: summary.style.classes.length,
      trained: summary.style.trained,
      accuracy: fmt(summary.style.accuracy),
      emitted: t(summary.style.emitted ? "CLI.FINGERPRINTS.STYLE_ON" : "CLI.FINGERPRINTS.STYLE_OFF"),
    }),
  );
  for (const f of summary.families) {
    if (re && !re.test(f.family)) continue;
    consola.info(
      t("CLI.FINGERPRINTS.FAMILY", {
        family: f.family,
        maker: f.maker ?? "unknown",
        profiles:
          f.profiles.map((p) => `${p.name} (${p.lanes} lanes, ${p.validCells} cells)`).join(", ") ||
          t("CLI.FINGERPRINTS.NO_PROFILE"),
        baseline: fmt(f.baselinePromptTokens, 0),
      }),
    );
    for (const l of f.lanes)
      consola.info(
        t("CLI.FINGERPRINTS.LANE", {
          key: l.key,
          runs: l.runs,
          samples: l.samples,
          verdict: l.verdict ?? "-",
          jsd: fmt(l.jsd),
          against: l.against ?? "-",
          mix: fmt(l.identityMix),
          wrapper: fmt(l.wrapperTokens, 0),
          style: l.styleMaker ? `${l.styleMaker.top} ${fmt(l.styleMaker.p)}` : "-",
        }),
      );
  }
}
