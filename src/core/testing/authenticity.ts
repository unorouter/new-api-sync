/**
 * Authenticity for every text lane: ai-model-verifier's rule engine on the wire
 * the channel is sold on, judged against the model's maker, mapped onto the
 * verdict cache. Only Claude's verdicts carry authority today; for every other
 * maker the ladder observes (every finding is recorded, none rejects) until the
 * observation log has shown how those models answer. `authenticity.observeOnly`
 * in config.yml promotes a maker by naming fewer rules, `[]` for none.
 */

import { paceUpstreamRequest } from "@core/infra/concurrency";
import { fetchSameHost } from "@core/infra/http";
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
import { normalizeModelId } from "ai-model-verifier/models";
import type { TokenizerFingerprintResult } from "ai-model-verifier/rules";
import { toBareName } from "@core/catalog/bare-name";
import {
  answerFingerprintDue,
  answerFingerprintRepeats,
  laneHistory,
  recordFingerprintRun,
} from "./answer-fingerprints";
import { consola } from "consola";
import { cannedReplyMarker, injectedLinkMarker } from "./canned-replies";
import { recordReplyCost } from "./probe-cost";
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
export type AuthenticityWire = Extract<
  VendorId,
  "anthropic" | "openai" | "gemini"
>;

// The behavioural ladder, in the library's precedence order.
const LADDER: readonly RuleId[] = [
  "thinking-floor",
  "coding-tool",
  "scam",
  "cjk-leak",
  "mux",
  "foreign",
  "quorum",
  "tier-self-report",
];
// Judged for every maker: a model coached to hide its backend restates the
// coaching in its own reasoning, which no self-confusion explains away; a
// platform refusal sent as the reply at 200 is billed and never failed over; and
// a reply whose own model field names another model is not the model sold. A
// model that thinks only when asked and skips it at high effort is the same
// model run without its reasoning, which users read as a worse one. A persona
// prompt cannot change how the backend splits text, so a vocabulary of another
// maker is another model. A Western lab's model that will not talk about
// Tiananmen 1989 is a Chinese model under its name.
const ENFORCED: readonly RuleId[] = [
  "masked-identity",
  "fake-200",
  "censored-history",
  "substituted",
  "served-model-mismatch",
  "thinking-honored",
  "tokenizer-family",
];
// Never a verdict, only evidence. The survey asks its own questions (injected
// system prompt, a sum, a JSON self-description); the answer fingerprint is
// the one-word battery accumulated per lane in answer-fingerprints.ts.
const OBSERVED: readonly RuleId[] = [
  "signature",
  "token-truth",
  "envelope",
  "survey",
  "think-leak",
  "wrapper-leak",
  "mask-contradiction",
  "answer-fingerprint",
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

type ReplyMeta = { requestId?: string; replyCost?: number };
// The library logs a probe without its response headers, so the transport
// queues each reply's id and price under the prompt it sent and the log takes
// them back in order (repeated fingerprint cells send identical prompts).
type ReplyMetaQueue = Map<string, ReplyMeta[]>;

function promptKey(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  for (const field of ["messages", "contents", "input", "prompt"])
    if (field in body) return JSON.stringify(Reflect.get(body, field));
  return "";
}

/** Bridges the library's injected transport onto plain fetch with our pacing. */
const verifierTransport =
  (
    replies: ReplyMetaQueue,
    extraHeaders?: Record<string, string>,
  ): TransportFn =>
  async (args) => {
    try {
      await paceUpstreamRequest(args.url);
      const res = await fetchSameHost(args.url, {
        method: "POST",
        headers: { ...args.headers, ...extraHeaders },
        body: JSON.stringify(args.reqBody),
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      const requestId = recordProbeRequestId(
        res.headers,
        new URL(args.url).host,
      );
      const text = await res.text().catch(() => "");
      const replyCost = recordReplyCost(
        new URL(args.url).host,
        res.headers,
        text,
      );
      const key = promptKey(args.reqBody);
      const queue = replies.get(key) ?? [];
      queue.push({
        ...(requestId !== null ? { requestId } : {}),
        ...(replyCost !== null ? { replyCost } : {}),
      });
      replies.set(key, queue);
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return {
        status: res.status,
        data,
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
  (key: string, replies: ReplyMetaQueue) =>
  (a: ProbeAttempt): void => {
    const reply = replies.get(promptKey(a.request.body))?.shift() ?? {};
    const entry: AuthenticityProbeLog = {
      ...reply,
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
  const provider = opts.logKey.split("|")[0] ?? opts.logKey;
  const probe = (label: string) => run.probes.find((p) => p.label === label);
  const identity = [probe("identity"), probe("model-name")];
  const survey = (label: string) =>
    run.reports.survey?.find((s) => s.label === label)?.answer ?? "";
  // The judgement on the line is the previous pass's: the line is written
  // before the lanes are judged, and the fingerprint needs days anyway.
  const history = laneHistory(opts.logKey);
  recordObservation({
    at: new Date().toISOString(),
    key: opts.logKey,
    provider,
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
      finishReason: p.finishReason,
      reasoning: p.reasoning,
      errorBody: p.errorBody,
      text: p.responseText,
    })),
    reports: run.reports,
    ...(history ? { laneHistory: history } : {}),
  });
  recordFingerprintRun({
    key: opts.logKey,
    provider,
    model: opts.model,
    family: normalizeModelId(toBareName(opts.model)),
    maker: opts.maker,
    host: new URL(opts.baseUrl).host,
    run: {
      at: new Date().toISOString(),
      sample: run.reports.answerFingerprint ?? null,
      foreign: identity.some((p) => p?.signal === "foreign"),
      answered: identity.every((p) => !!p?.responseText),
      // A relay that reports no usage sends 0, which is no measurement.
      promptTokens: probe("creative")?.usage?.prompt || null,
      text: [
        probe("emotional")?.responseText ?? "",
        probe("creative")?.responseText ?? "",
        survey("self"),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1200),
    },
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
  // The tokenizer fingerprint rides on every ladder run: its verdict is
  // Claude-only inside the library, so for other makers it is the two deltas
  // on the record and nothing else.
  // A rule named in `only` runs even with its check off, so a warm lane drops
  // the battery from the list rather than only from `checks`.
  const battery = opts.ladder && answerFingerprintDue(opts.logKey);
  const only: RuleId[] = [
    ...(opts.ladder
      ? [
          ...LADDER,
          ...ENFORCED,
          ...OBSERVED.filter((r) => battery || r !== "answer-fingerprint"),
        ]
      : []),
    ...(opts.fingerprint || opts.ladder
      ? ["tokenizer-fingerprint" as const]
      : []),
  ];
  if (only.length === 0) return { authentic: null };
  const replies: ReplyMetaQueue = new Map();
  const run = await runRules({
    vendor: opts.wire,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    mode: "server",
    timeoutMs: opts.timeoutMs,
    transport: verifierTransport(replies, opts.extraHeaders),
    ...(opts.extraBody ? { bodyExtras: opts.extraBody } : {}),
    onProbe: probeLog(opts.logKey, replies),
    only,
    checks: battery
      ? { answerFingerprint: { repeats: answerFingerprintRepeats() } }
      : {},
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

  const replyTextsSeen = [
    ...run.probes.map((p) => p.responseText),
    ...(run.reports.survey ?? []).map((s) => s.text),
  ];
  const canned = cannedReplyMarker(replyTextsSeen);
  const injected = canned ? undefined : injectedLinkMarker(replyTextsSeen);
  if (canned || injected) {
    const reason = canned
      ? `canned reply: "${canned}"`
      : `injected content: ${injected}`;
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_FAIL", {
        model: opts.model,
        rule: canned ? "canned-reply" : "injected-content",
        reason,
      }),
    );
    setAuthenticityVerdict(opts.logKey, "fail", reason);
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_ADDED", { key: opts.logKey, reason }),
    );
    return { authentic: false, ...(fingerprint ? { fingerprint } : {}) };
  }

  // Observe-only silences a rule's fail, not its lack of evidence: a reseller
  // passed 10 lanes on 2026-11-09 with every probe answering 402.
  if (
    !decisive &&
    !run.probes.some((p) => !p.transient && (p.responseText ?? "") !== "")
  ) {
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_INCONCLUSIVE", {
        model: opts.model,
        reason: "no probe answered",
      }),
    );
    return { authentic: null, ...(fingerprint ? { fingerprint } : {}) };
  }
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
