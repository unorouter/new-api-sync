/**
 * Authenticity for Claude lanes: ai-model-verifier's rule engine on the wire
 * the channel is sold on, mapped onto the verdict cache. Verdicts live in the
 * universal verdict-cache (logs/verdict-cache.json), shared with the general
 * http/stream/tool verdicts.
 */

import { paceUpstreamRequest } from "@core/infra/concurrency";
import { logsDir } from "@core/infra/paths";
import { t } from "@server/i18n";
import {
  runRules,
  type Finding,
  type ProbeAttempt,
  type Reports,
  type RuleId,
  type TransportFn,
  type VendorId,
} from "ai-model-verifier";
import type { TokenizerFingerprintResult } from "ai-model-verifier/rules";
import { consola } from "consola";
import { appendFileSync } from "fs";
import { join } from "path";
import { recordProbeRequestId } from "./probe-ids";
import type { AuthenticityProbeLog } from "./types";
import {
  getVerdict,
  isAuthenticityFailFresh,
  isAuthenticityPassFresh,
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
// Observe only: written down, never a verdict. A false positive in a fresh
// detector would delete lanes serving real traffic, so the numbers get
// reviewed before they get authority.
const OBSERVED: readonly RuleId[] = ["signature", "token-truth", "envelope"];

/** Bridges the library's injected transport onto plain fetch with our pacing. */
const verifierTransport: TransportFn = async (args) => {
  try {
    await paceUpstreamRequest(args.url);
    const res = await fetch(args.url, {
      method: "POST",
      headers: args.headers,
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

function writeObserveLine(label: string, model: string, reports: Reports) {
  const notable =
    reports.signature?.state === "no-thinking" ||
    reports.tokenTruth?.ok === false
      ? "WOULD-FLAG"
      : null;
  try {
    appendFileSync(
      join(logsDir(), `observe-${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({
        at: new Date().toISOString(),
        lane: label,
        model,
        notable,
        signature: reports.signature,
        tokens: reports.tokenTruth,
        envelope: reports.responseMetadata,
      }) + "\n",
    );
  } catch (err) {
    consola.debug(
      `[observe] ${label} skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (notable)
    consola.info(
      `[observe] ${label}: ${notable} (signature=${reports.signature?.state}, tokens=${
        reports.tokenTruth?.checks
          .filter((c) => !c.pass)
          .map((c) => c.id)
          .join(",") || "ok"
      })`,
    );
}

export type AuthenticityRun = {
  /** true: passed and recorded; false: failed and blacklisted; null: not decided this run. */
  authentic: boolean | null;
  fingerprint?: TokenizerFingerprintResult;
};

/**
 * Run the ladder and/or the tokenizer fingerprint on one lane. A verdict
 * finding blacklists the lane with the library's reason; an inconclusive one
 * (only transient shortfalls) leaves it unverified this run without a cache
 * write, so a rate limited lane is probed again instead of banned.
 */
export async function runAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  logKey: string;
  wire: AuthenticityWire;
  extraBody?: Record<string, unknown>;
  ladder: boolean;
  fingerprint: boolean;
}): Promise<AuthenticityRun> {
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
    transport: verifierTransport,
    ...(opts.extraBody ? { bodyExtras: opts.extraBody } : {}),
    onProbe: probeLog(opts.logKey),
    only,
  });
  const fingerprint = run.reports.tokenizerFingerprint;
  if (!opts.ladder)
    return { authentic: null, ...(fingerprint ? { fingerprint } : {}) };

  writeObserveLine(opts.logKey, opts.model, run.reports);
  for (const f of run.findings.filter((f) => f.severity === "note"))
    consola.info(
      t("CORE.TESTER.AUTHENTICITY_NOTE", {
        model: opts.model,
        rule: f.rule,
        reason: f.reason,
      }),
    );

  const decisive: Finding | undefined = run.findings.find(
    (f) => f.severity !== "note",
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
