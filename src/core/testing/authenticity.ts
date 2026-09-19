/**
 * Authenticity for every text lane: ai-model-verifier's rule engine on the wire
 * the channel is sold on, judged against the model's maker, mapped onto the
 * verdict cache. Only Claude's verdicts carry authority today; for every other
 * maker the ladder observes (every finding is recorded, none rejects) until the
 * observation log has shown how those models answer. `authenticity.observeOnly`
 * in config.yml promotes a maker by naming fewer rules, `[]` for none.
 */

import { paceUpstreamRequest } from "@core/infra/concurrency";
import { t } from "@server/i18n";
import {
  runRules,
  type Finding,
  type ProbeAttempt,
  type RuleId,
  type RuleRun,
  type TransportFn,
  type VendorId,
} from "ai-model-verifier";
import type { MakerId } from "ai-model-verifier/makers";
import type { TokenizerFingerprintResult } from "ai-model-verifier/rules";
import { consola } from "consola";
import { recordProbeRequestId } from "./probe-ids";
import type { AuthenticityProbeLog } from "./types";
import {
  getVerdict,
  isAuthenticityFailFresh,
  isAuthenticityPassFresh,
  recordObservation,
  setAuthenticityVerdict,
} from "./verdict-cache";

export const authenticityProbeAccumulator = new Map<
  string,
  AuthenticityProbeLog[]
>();

export function resetAuthenticityProbes(): void {
  authenticityProbeAccumulator.clear();
}

export const isAuthenticityBlacklisted = (key: string): boolean =>
  isAuthenticityFailFresh(getVerdict(key));

export const isAuthenticityPassCached = (
  key: string,
  baseUrl?: string,
): boolean => isAuthenticityPassFresh(getVerdict(key), baseUrl);

/** Wire format of the probe: the one the channel is sold on. */
export type AuthenticityWire = Extract<VendorId, "anthropic" | "openai">;

// The behavioural ladder, in the library's precedence order.
const LADDER: readonly RuleId[] = [
  "thinking-floor",
  "coding-tool",
  "scam",
  "cjk-leak",
  "mux",
  "foreign",
  "served-model-mismatch",
  "substituted",
  "quorum",
  "tier-self-report",
];
// Never a verdict, only evidence. The survey asks its own questions (cutoff,
// context window, injected system prompt, a sum, a JSON self-description).
const OBSERVED: readonly RuleId[] = [
  "signature",
  "token-truth",
  "envelope",
  "survey",
];

let observeOnlyByMaker: Record<string, readonly string[]> = {};

/** From config.yml `authenticity.observeOnly`: rules that only log, per maker id or `*`. */
export function setAuthenticityObserveOnly(
  cfg?: Record<string, readonly string[]>,
): void {
  observeOnlyByMaker = cfg ?? {};
}

function observedFor(maker: MakerId | null): ReadonlySet<string> {
  const cfg =
    (maker ? observeOnlyByMaker[maker] : undefined) ?? observeOnlyByMaker["*"];
  if (cfg) return new Set(cfg);
  return new Set(maker === "anthropic" ? [] : LADDER);
}

/** Bridges the library's injected transport onto plain fetch with our pacing. */
const verifierTransport =
  (extraHeaders?: Record<string, string>): TransportFn =>
  async (args) => {
    try {
      await paceUpstreamRequest(args.url);
      const res = await fetch(args.url, {
        method: "POST",
        headers: { ...args.headers, ...extraHeaders },
        body: JSON.stringify(args.reqBody),
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      recordProbeRequestId(res.headers, new URL(args.url).host);
      return {
        status: res.status,
        data: await res.json().catch(() => null),
        error: null,
        corsBlocked: false,
      };
    } catch (err) {
      return {
        status: null,
        data: null,
        error: err instanceof Error ? err.message : String(err),
        corsBlocked: false,
      };
    }
  };

const probeLog =
  (key: string) =>
  (a: ProbeAttempt): void => {
    const entry: AuthenticityProbeLog = {
      probe: a.label,
      pass: a.pass,
      authenticityRefusal: a.signal === "coding-tool",
      request: { url: a.request.url, body: a.request.body },
      response: a.responseText,
      ...(a.error !== undefined ? { error: a.error } : {}),
    };
    const list = authenticityProbeAccumulator.get(key);
    if (list) list.push(entry);
    else authenticityProbeAccumulator.set(key, [entry]);
  };

export type AuthenticityRun = {
  /** true: passed and recorded; false: failed and blacklisted; null: not decided this run. */
  authentic: boolean | null;
  fingerprint?: TokenizerFingerprintResult;
};

type LaneOpts = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maker: MakerId | null;
  timeoutMs: number;
  logKey: string;
  wire: AuthenticityWire;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
};

/**
 * One line per ladder run with everything the probes saw, so weeks of runs
 * can be read back per maker, per lane and per rule before any rule gets
 * authority over that maker.
 */
function observe(
  opts: LaneOpts,
  run: RuleRun,
  observed: ReadonlySet<string>,
  decisive: Finding | undefined,
): void {
  const wouldFlag = run.findings
    .filter((f) => f.severity !== "note" && observed.has(f.rule))
    .map((f) => f.rule);
  recordObservation({
    at: new Date().toISOString(),
    key: opts.logKey,
    provider: opts.logKey.split("|")[0] ?? opts.logKey,
    model: opts.model,
    maker: opts.maker,
    wire: opts.wire,
    host: new URL(opts.baseUrl).host,
    ...(opts.extraBody ? { extraBody: opts.extraBody } : {}),
    ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    observeOnly: [...observed],
    verdict: decisive
      ? decisive.severity === "inconclusive"
        ? "inconclusive"
        : "fail"
      : "pass",
    decisive: decisive?.rule ?? null,
    wouldFlag,
    findings: run.findings.map((f) => ({
      rule: f.rule,
      layer: f.layer,
      severity: f.severity,
      reason: f.reason,
    })),
    probes: run.probes.map((p) => ({
      label: p.label,
      pass: p.pass,
      signal: p.signal,
      reason: p.reason,
      transient: p.transient,
      muxFailure: p.muxFailure,
      httpStatus: p.httpStatus,
      latencyMs: p.latencyMs,
      detectedModel: p.detectedModel,
      usage: p.usage,
      text: p.responseText,
    })),
    reports: run.reports,
  });
  for (const f of run.findings)
    if (f.severity !== "note" && observed.has(f.rule))
      consola.info(
        t("CORE.TESTER.AUTHENTICITY_OBSERVED", {
          model: opts.model,
          rule: f.rule,
          reason: f.reason,
          maker: opts.maker ?? "unknown",
        }),
      );
}

/**
 * Run the ladder and/or the tokenizer fingerprint on one lane. A decisive
 * finding blacklists the lane with the library's reason; an inconclusive one
 * (only transient shortfalls) leaves it unverified this run without a cache
 * write, so a rate limited lane is probed again instead of banned. A finding
 * on an observed rule is recorded and has no say.
 */
export async function runAuthenticity(
  opts: LaneOpts & { ladder: boolean; fingerprint: boolean },
): Promise<AuthenticityRun> {
  const only: RuleId[] = [
    ...(opts.ladder ? [...LADDER, ...OBSERVED] : []),
    ...(opts.fingerprint ? ["tokenizer-fingerprint" as const] : []),
  ];
  if (only.length === 0) return { authentic: null };
  const run = await runRules({
    vendor: opts.wire,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    mode: "server",
    timeoutMs: opts.timeoutMs,
    transport: verifierTransport(opts.extraHeaders),
    ...(opts.extraBody ? { bodyExtras: opts.extraBody } : {}),
    onProbe: probeLog(opts.logKey),
    only,
  });
  const fingerprint = run.reports.tokenizerFingerprint;
  if (!opts.ladder)
    return { authentic: null, ...(fingerprint ? { fingerprint } : {}) };

  const observed = observedFor(opts.maker);
  const decisive: Finding | undefined = run.findings.find(
    (f) => f.severity !== "note" && !observed.has(f.rule),
  );
  observe(opts, run, observed, decisive);
  for (const f of run.findings.filter((f) => f.severity === "note"))
    consola.info(
      t("CORE.TESTER.AUTHENTICITY_NOTE", {
        model: opts.model,
        rule: f.rule,
        reason: f.reason,
      }),
    );

  if (!decisive) {
    setAuthenticityVerdict(opts.logKey, "pass", "");
    return { authentic: true, ...(fingerprint ? { fingerprint } : {}) };
  }
  if (decisive.severity === "inconclusive") {
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_INCONCLUSIVE", {
        model: opts.model,
        reason: decisive.reason,
      }),
    );
    return { authentic: null, ...(fingerprint ? { fingerprint } : {}) };
  }
  consola.warn(
    t("CORE.TESTER.AUTHENTICITY_FAIL", {
      model: opts.model,
      rule: decisive.rule,
      reason: decisive.reason,
    }),
  );
  setAuthenticityVerdict(opts.logKey, "fail", decisive.reason);
  consola.warn(
    t("CORE.TESTER.AUTHENTICITY_ADDED", {
      key: opts.logKey,
      reason: decisive.reason,
    }),
  );
  return { authentic: false, ...(fingerprint ? { fingerprint } : {}) };
}
