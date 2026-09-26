import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import {
  inferModelType,
  isTestableModel,
} from "@core/catalog/constants/inference";
import { logTestSummary } from "@core/catalog/test-log";
import { throwIfRunAborted } from "@core/infra/abort";
import { getConcurrencyGate } from "@core/infra/concurrency";
import { TIMEOUTS, type ModelType } from "@core/types";
import { t } from "@server/i18n";
import { timingSnapshot } from "@core/infra/timing";
import { consola } from "consola";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  authenticityProbeAccumulator,
  isAuthenticityBlacklisted,
  isAuthenticityPassCached,
  resetAuthenticityProbes,
  runAuthenticity,
} from "./authenticity";
import {
  getVerdict,
  isAuthenticityPassFresh,
  isTestFailFresh,
  isTestPassFresh,
  recordTestVerdict,
  recordTokenizerDelta,
  saveVerdictCache,
  setAuthenticityVerdict,
} from "./verdict-cache";
import {
  mergeProbeBody,
  testRequest,
  testStreamRequest,
  testToolCallRequest,
  withRetry,
  type RetryPolicy,
} from "./execution";
import {
  getAudioTestConfig,
  getEmbeddingTestConfig,
  getImageTestConfig,
  getRequestConfig,
  getStreamRequestConfig,
  getToolCallConfig,
  getVideoTestConfig,
} from "./request-configs";
import type {
  ModelRequestOpts,
  ModelTestDetail,
  ModelTestLog,
  OpenRouterEndpointsLog,
  PricingGateLog,
  ProviderCostEntry,
  TestExchange,
  TestReport,
} from "./types";
import type { ApplyReport, ProviderReport, SyncDiff } from "@core/types";
import { redactExchange, redactUrl } from "./redact";
import { makerForModel } from "ai-model-verifier/makers";
import { modelsMatch } from "ai-model-verifier/models";
import { fingerprintDrifted, mustAlwaysThink } from "ai-model-verifier/rules";

let testReport: TestReport = {
  timestamp: new Date().toISOString(),
  providers: {},
  modelTests: [],
};
const passingByKey = new Map<string, ModelTestLog>();
const passKey = (provider: string, model: string) => `${provider}|${model}`;

// Dry-run gate: when set, testAndFilterModels treats every testable model as
// working and sends no upstream requests (no cost). runProviderPipeline sets
// it for the duration of one pipeline run.
let dryRunMode = false;
export function setDryRunMode(on: boolean): void {
  dryRunMode = on;
}

// Reset module-level state per run so the server doesn't leak run N's cache into N+1.
export function resetTestState(): void {
  testReport = {
    timestamp: new Date().toISOString(),
    providers: {},
    modelTests: [],
  };
  passingByKey.clear();
  dryRunMode = false;
  resetAuthenticityProbes();
}

function redactedReport(): TestReport {
  const pg = testReport.pricingGate;
  const oe = testReport.openrouterEndpoints;
  return {
    timestamp: testReport.timestamp,
    providers: testReport.providers,
    summary: testReport.summary,
    modelTests: testReport.modelTests.map((e) => ({
      ...e,
      http: redactExchange(e.http),
      stream: e.stream ? redactExchange(e.stream) : null,
      toolCall: e.toolCall ? redactExchange(e.toolCall) : null,
      authenticityProbes: e.authenticityProbes?.map((p) => ({
        ...p,
        request: { ...p.request, url: redactUrl(p.request.url) },
      })),
    })),
    pricingGate: pg && pg.length > 0 ? pg : undefined,
    openrouterEndpoints: oe && oe.length > 0 ? oe : undefined,
  };
}

function addTestResult(entry: ModelTestLog): void {
  const key = passKey(entry.provider, entry.model);
  entry.authenticityProbes = authenticityProbeAccumulator.get(key);
  testReport.modelTests.push(entry);
  if (entry.http.pass) passingByKey.set(key, entry);
}

function ensureProviderEntry(provider: string): ProviderCostEntry {
  let entry = testReport.providers[provider];
  if (!entry) testReport.providers[provider] = entry = {};
  return entry;
}

export function recordProviderCost(provider: string, testCost: number): void {
  ensureProviderEntry(provider).testCost = testCost;
}

export function recordRunSummary(input: {
  providerReports: ProviderReport[];
  apply: ApplyReport;
  diff: SyncDiff;
  elapsedMs: number;
  success: boolean;
}): void {
  for (const r of input.providerReports) {
    const entry = ensureProviderEntry(r.name);
    entry.success = r.success;
    if (r.error) entry.error = r.error;
    entry.groups = r.groups;
    entry.models = r.models;
    entry.tokens = r.tokens;
  }

  const channelTagByName = new Map<string, string>();
  for (const op of input.diff.channels) {
    const channel = op.type === "delete" ? op.existing : op.value;
    if (channel.tag) channelTagByName.set(channel.name, channel.tag);
  }
  const ops: Array<["created" | "updated" | "deleted", string[]]> = [
    ["created", input.apply.channels.created],
    ["updated", input.apply.channels.updated],
    ["deleted", input.apply.channels.deleted],
  ];
  for (const [op, keys] of ops) {
    for (const key of keys) {
      const tag = channelTagByName.get(key);
      if (!tag) continue;
      const entry = ensureProviderEntry(tag);
      if (!entry.channels)
        entry.channels = { created: [], updated: [], deleted: [] };
      entry.channels[op].push(key);
    }
  }

  testReport.summary = {
    providers: {
      passed: input.providerReports.filter((p) => p.success).length,
      total: input.providerReports.length,
    },
    channels: input.apply.channels,
    models: input.apply.models,
    options: input.apply.options,
    elapsedSeconds: +(input.elapsedMs / 1000).toFixed(2),
    timing: timingSnapshot(),
    success: input.success,
    errors: input.apply.errors.length > 0 ? input.apply.errors : undefined,
  };
}

export function recordPricingGate(entry: PricingGateLog): void {
  if (!testReport.pricingGate) testReport.pricingGate = [];
  if (testReport.pricingGate.some((e) => e.exposed === entry.exposed)) return;
  testReport.pricingGate.push(entry);
}

export function recordOpenRouterEndpointsForModel(
  entry: OpenRouterEndpointsLog,
): void {
  if (!testReport.openrouterEndpoints) testReport.openrouterEndpoints = [];
  if (testReport.openrouterEndpoints.some((e) => e.id === entry.id)) return;
  testReport.openrouterEndpoints.push(entry);
}

export function writeTestReport(): string | null {
  saveVerdictCache();
  if (testReport.modelTests.length === 0) return null;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logsDir, `${ts}-model-tests.json`);
  writeFileSync(path, JSON.stringify(redactedReport(), null, 2));
  consola.info(t("CORE.TESTER.REPORT_WRITTEN", { path }));
  return path;
}

// Rate limits / upstream outages / network errors are NOT evidence the model can't
// call tools; only a definitive 4xx or a completed-but-toolless response is.
function isTransientToolFailure(r: TestExchange): boolean {
  return r.status === undefined || r.status === 429 || r.status >= 500;
}

// The model name a response claims, when the upstream echoes one.
function servedModel(r: TestExchange | null): string | null {
  const data = r?.response;
  if (!data || typeof data !== "object") return null;
  const m = (data as { model?: unknown }).model;
  return typeof m === "string" && m.length > 0 ? m : null;
}

// Dots and dashes are interchangeable across relays (claude-opus-4.8 vs
// claude-opus-4-8) and dated ids are the same model as their base
// (claude-haiku-4-5-20251001), so compare on the shared prefix.

export interface ModelCapabilityHint {
  supportsTools?: boolean;
  isReasoning?: boolean;
}

const HTTP_CONFIG_BY_TYPE = {
  image: getImageTestConfig,
  video: getVideoTestConfig,
  embedding: getEmbeddingTestConfig,
  audio: getAudioTestConfig,
  text: getRequestConfig,
} as const;

// prettier-ignore
const mkDetail = (model: string, channelType: number, success: boolean, streamSuccess: boolean | null, toolCallSuccess: boolean | null, toolParallel: boolean | null, authenticityProbed: boolean, httpStatus?: number, errorText?: string): ModelTestDetail => ({ model, success, streamSuccess, toolCallSuccess, toolParallel, authenticityProbed, channelType, ...(httpStatus !== undefined && { httpStatus }), ...(errorText && { errorText }) });

const exchangeErrorText = (r: TestExchange): string =>
  (typeof r.response === "string" ? r.response : JSON.stringify(r.response ?? r.error ?? "")).slice(0, 300);

// Balance-type answers: the caller's own wallet at that upstream is empty, which
// says nothing about whether the lane works.
const BALANCE_ERROR_RE = /可用额度不足|余额不足|额度不足|insufficient[_ ](user_)?(quota|balance|credit)|no credits available|out of credits|credit balance is too low/i;
export const isBalanceError = (d: ModelTestDetail): boolean =>
  !d.success && d.errorText !== undefined && BALANCE_ERROR_RE.test(d.errorText);

// Rate limits, gateway errors and timeouts clear within hours; a 4xx, a wrong
// model or a substitution does not.
function isTransientStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

async function testModels(opts: {
  baseUrl: string;
  apiKey: string;
  /** Per-model credential, for upstreams that mint one key per model. */
  apiKeyFor?: (model: string) => string | undefined;
  models: string[];
  channelType: number;
  useResponsesAPI?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  logPrefix?: string;
  modelEndpoints?: Map<string, string[]>;
  retryPolicy?: RetryPolicy<TestExchange>;
  acceptRateLimited?: boolean | ((model: string) => boolean);
  // Set only for a hand-verified first party whose upstream persona trips
  // the probe; see skipAuthenticity in validations/config.ts.
  skipAuthenticity?: boolean;
  capabilities?: Map<string, ModelCapabilityHint>;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  familyOf?: (model: string) => string;
}): Promise<{
  workingModels: string[];
  rateLimitedModels: string[];
  details: ModelTestDetail[];
}> {
  const useResponsesAPI = opts.useResponsesAPI ?? false;
  const familyOf = opts.familyOf ?? ((model: string) => model);
  // A lane's pin (body) and bid (headers) ride on every probe, so the probes
  // reach the provider the lane is priced on.
  const withExtraBody = <
    C extends { body: unknown; headers: Record<string, string> },
  >(
    cfg: C,
  ): C => ({
    ...cfg,
    ...(opts.extraBody
      ? { body: mergeProbeBody(cfg.body, opts.extraBody) }
      : {}),
    ...(opts.extraHeaders
      ? { headers: { ...cfg.headers, ...opts.extraHeaders } }
      : {}),
  });
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.MODEL_TEST_MS;
  const prefix = opts.logPrefix ?? "unknown";
  const gate = getConcurrencyGate();
  void opts.concurrency;

  const results: ModelTestDetail[] = await Promise.all(
    opts.models.map((model) =>
      gate.run(opts.baseUrl, async () => {
        throwIfRunAborted();
        const ep = passingByKey.get(passKey(prefix, model));
        if (ep)
          return mkDetail(
            model,
            opts.channelType,
            true,
            ep.stream?.pass ?? null,
            ep.toolCall?.pass ?? null,
            ep.toolCall?.toolParallel ?? null,
            false,
          );

        const blacklistKey = `${prefix}|${model}`;
        const apiKey = opts.apiKeyFor?.(model) ?? opts.apiKey;
        const maker = makerForModel(familyOf(model));
        const isAnthropic = maker === "anthropic";
        // Keyed on the MODEL, not the channel type: a7/openrouter test claude
        // over OpenAI-compat, and a blacklisted faker re-probed on every run
        // eventually passes once (fake identities are nondeterministic) and
        // wins a channel. Blacklisted stays blacklisted until hand-pruned.
        // A recorded fail is final for every model: the floor and substitution
        // checks write one for gemini/kimi/glm too, and a lane that beat them
        // once on a lucky probe must not come back (a7 2418 did).
        if (!opts.skipAuthenticity && isAuthenticityBlacklisted(blacklistKey)) {
          const http: TestExchange = {
            pass: false,
            request: { url: "", headers: {}, body: null },
            response: null,
            responseHeaders: {},
            error: t("CORE.TESTER.ERR_AUTHENTICITY_BLACKLISTED"),
          };
          addTestResult({
            provider: prefix,
            model,
            cost: null,
            http,
            stream: null,
            toolCall: null,
            authentic: false,
          });
          return mkDetail(
            model,
            opts.channelType,
            false,
            null,
            null,
            null,
            false,
          );
        }

        const reqOpts: ModelRequestOpts = {
          baseUrl: opts.baseUrl,
          apiKey,
          model,
          channelType: opts.channelType,
          useResponsesAPI,
        };
        const modelType = inferModelType(model, undefined, opts.modelEndpoints);
        const isText = modelType === "text";

        // Verdict reuse (logs/verdict-cache.json): a pair with a recorded pass is
        // not re-probed; force a retest by deleting its entry. Text pairs
        // additionally require a FRESH authenticity pass (verifiedAt inside
        // AUTHENTICITY_PASS_TTL_HOURS), so a merchant that swaps its backend after
        // the probe is re-checked within hours instead of never. Text pairs without a
        // definitive tool verdict fall through so the tool probe can complete them.
        const identityChecked = isText && !opts.skipAuthenticity;
        const cached = getVerdict(blacklistKey);
        if (isTestFailFresh(cached)) {
          addTestResult({
            provider: prefix,
            model,
            cost: null,
            http: {
              pass: false,
              request: { url: "", headers: {}, body: null },
              response: null,
              responseHeaders: {},
              error: t("CORE.TESTER.ERR_FAIL_CACHED", {
                at: cached?.failedAt ?? "",
              }),
            },
            stream: null,
            toolCall: null,
            authentic: null,
          });
          return mkDetail(
            model,
            opts.channelType,
            false,
            null,
            null,
            null,
            false,
            cached?.failStatus,
          );
        }
        const cachedTool =
          cached && cached.toolCallSuccess != null
            ? {
                pass: cached.toolCallSuccess,
                parallel: cached.toolParallel ?? null,
              }
            : null;
        if (
          cached &&
          isTestPassFresh(cached) &&
          (!isText || cachedTool) &&
          (!identityChecked || isAuthenticityPassFresh(cached, opts.baseUrl))
        )
          return mkDetail(
            model,
            opts.channelType,
            true,
            cached.streamSuccess ?? null,
            cachedTool?.pass ?? null,
            cachedTool ? cachedTool.parallel : null,
            false,
          );

        const streamBase = isText ? getStreamRequestConfig(reqOpts) : null;
        const streamConfig = streamBase && withExtraBody(streamBase);
        const toolBase =
          isText && !cachedTool
            ? getToolCallConfig(reqOpts, opts.capabilities?.get(model))
            : null;
        const toolCfg = toolBase && withExtraBody(toolBase);
        const retry = (fn: () => Promise<TestExchange>) =>
          withRetry(fn, (r) => r.pass, opts.retryPolicy);
        // A definitive tool fail is paid generation; only transients are worth re-buying.
        const retryTool = (fn: () => Promise<TestExchange>) =>
          withRetry(fn, (r) => r.pass, {
            ...opts.retryPolicy,
            shouldRetry: isTransientToolFailure,
          });
        const [httpResult, streamResult, toolResult] = await Promise.all([
          retry(() =>
            testRequest(
              withExtraBody(HTTP_CONFIG_BY_TYPE[modelType](reqOpts)),
              timeoutMs,
            ),
          ),
          streamConfig
            ? retry(() => testStreamRequest(streamConfig, timeoutMs))
            : null,
          toolCfg
            ? retryTool(() => testToolCallRequest(toolCfg, timeoutMs))
            : null,
        ]);
        // A relay that answers a cheaper model than the one billed for passes
        // every behavioural probe: the reply IS a real Claude, just not the one
        // asked for. Only the echoed model name catches it (bcc1 "hyper" served
        // opus-4-6 for both opus-4-8 and opus-4-7).
        const served = servedModel(httpResult) ?? servedModel(streamResult);
        // Relays tag free routes as "[free]model" and echo the plain upstream id.
        const substituted =
          served !== null && !modelsMatch(model.replace(/^\[[^\]]*\]/, ""), served);
        if (substituted) {
          consola.warn(
            `[${prefix}] ${model}: ${t("CORE.TESTER.ERR_MODEL_SUBSTITUTED", { got: served })}`,
          );
          setAuthenticityVerdict(blacklistKey, "fail", `substituted:${served}`);
        }

        // The thinking floor sits in the ladder, where the maker's observe
        // gate decides whether it judges.
        const rejected = substituted;

        const success = httpResult.pass && !rejected;
        const streamSuccess =
          streamResult === null ? null : streamResult.pass && !rejected;
        const toolCallSuccess: boolean | null = cachedTool
          ? cachedTool.pass
          : toolResult === null
            ? null
            : toolResult.pass
              ? true
              : isTransientToolFailure(toolResult)
                ? null
                : false;
        const toolParallel: boolean | null = cachedTool
          ? cachedTool.parallel
          : toolResult?.pass
            ? (toolResult.toolParallel ?? false)
            : null;

        // Probe over the wire the channel is sold on: a7 merchants that only
        // speak OpenAI chat answer /v1/messages with 400/403/404 and could
        // never verify. The tokenizer fingerprint is measured on every probe:
        // the billed input-token delta for a fixed text is deterministic per
        // lane, so a delta that moved since the last probe means the backend
        // changed and the cached authenticity pass is void this run. It names
        // no tier on its own. A cached pass means the generative ladder was
        // already paid for; it is trusted until it expires or the delta moves.
        let authentic = true;
        if (identityChecked && httpResult.pass) {
          const lane = {
            baseUrl: opts.baseUrl,
            apiKey,
            model,
            maker,
            timeoutMs,
            logKey: blacklistKey,
            wire:
              opts.channelType === CHANNEL_TYPES.ANTHROPIC
                ? ("anthropic" as const)
                : ("openai" as const),
            ...(opts.extraBody ? { extraBody: opts.extraBody } : {}),
            ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
          };
          const cachedPass = isAuthenticityPassCached(
            blacklistKey,
            opts.baseUrl,
          );
          // The tokenizer fingerprint is Claude's; other makers get the ladder only.
          const first = await runAuthenticity({
            ...lane,
            ladder: !cachedPass && !rejected,
            fingerprint: isAnthropic,
          });
          const fp = first.fingerprint;
          let drift = false;
          if (fp && fp.state === "measured" && fp.delta !== null) {
            drift = fingerprintDrifted(cached?.tokenizerDelta, fp);
            if (drift)
              consola.warn(
                `[${prefix}] ${model}: ${t("CORE.TESTER.TOKENIZER_DRIFT", { from: cached?.tokenizerDelta ?? 0, to: fp.delta })}`,
              );
            recordTokenizerDelta(blacklistKey, fp.delta);
          }
          if (cachedPass && drift && !rejected)
            authentic =
              (
                await runAuthenticity({
                  ...lane,
                  ladder: true,
                  fingerprint: false,
                })
              ).authentic === true;
          else if (!cachedPass) authentic = first.authentic === true;
        }

        const finalSuccess = success && authentic;
        const finalStream =
          streamSuccess === null ? null : streamSuccess && authentic;

        recordTestVerdict({
          key: blacklistKey,
          success: finalSuccess,
          streamSuccess: finalStream,
          toolCallSuccess,
          toolParallel,
          toolFresh: cachedTool === null,
          transientFail: !success && isTransientStatus(httpResult.status),
          failStatus: httpResult.status,
        });

        addTestResult({
          provider: prefix,
          model,
          cost: null,
          http: httpResult,
          stream: streamResult,
          toolCall: toolResult,
          authentic: identityChecked ? authentic : null,
        });

        const toLog = (r: TestExchange | null, pass: boolean) =>
          r === null
            ? undefined
            : {
                pass,
                status: r.status,
                latencyMs: r.latencyMs,
                error: r.error,
                body: r.response,
              };
        logTestSummary({
          prefix,
          model,
          modelType,
          http: toLog(httpResult, finalSuccess)!,
          stream: toLog(streamResult, finalStream === true),
          tool: toLog(toolResult, toolCallSuccess === true),
        });

        return mkDetail(
          model,
          opts.channelType,
          finalSuccess,
          finalStream,
          toolCallSuccess,
          toolParallel,
          identityChecked && (success || streamSuccess === true),
          httpResult.status,
          finalSuccess ? undefined : exchangeErrorText(httpResult),
        );
      }),
    ),
  );

  const reallyPassed = (r: (typeof results)[number]) =>
    r.success || r.streamSuccess === true;
  const acceptsTransient = (model: string) =>
    typeof opts.acceptRateLimited === "function"
      ? opts.acceptRateLimited(model)
      : opts.acceptRateLimited === true;
  // Transient upstream statuses that mean "try again later", not "broken": rate
  // limits (429) + gateway/timeout 5xx + the 405 upstream_error a reverse relay
  // (z.ai captcha pool) returns when the pool is momentarily drained.
  const TRANSIENT_STATUS = new Set([
    405, 408, 425, 429, 500, 502, 503, 504, 520, 522, 524,
  ]);
  // A throttled lane is never identity-checked, and the gateway's auto-test
  // enables it as soon as the upstream clears: for Claude that let a ChatGPT
  // merchant go live under a fable label (a7 3999). Only a lane that already
  // proved itself may ride a transient status in; a maker under observation
  // has nothing to prove yet.
  const acceptedTransient = (r: (typeof results)[number]) =>
    r.httpStatus != null &&
    TRANSIENT_STATUS.has(r.httpStatus) &&
    !reallyPassed(r) &&
    acceptsTransient(r.model) &&
    ((makerForModel(familyOf(r.model)) !== "anthropic" &&
      !mustAlwaysThink(r.model)) ||
      opts.skipAuthenticity === true ||
      isAuthenticityPassCached(passKey(prefix, r.model), opts.baseUrl));

  return {
    workingModels: results
      .filter((r) => reallyPassed(r) || acceptedTransient(r))
      .map((r) => r.model),
    // Models kept ONLY because of a transient status (throttle / gateway blip,
    // not a real pass). Channels for these are emitted disabled so new-api's
    // auto-test enables them once the upstream clears, instead of serving a
    // guaranteed-failing request.
    rateLimitedModels: results.filter(acceptedTransient).map((r) => r.model),
    details: results,
  };
}

// Authenticity-screen Claude models the pricing gate dropped without testing.
// The kiro detector only runs inside testModels, so a fake-Claude upstream that
// loses the cheapest-bucket vote ships unchecked. Probe identity only (no
// http/stream/tool, no offer) so a kiro group is blacklisted regardless of
// price rank. Returns models that failed the screen.
export async function screenDroppedClaudeAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  models: string[];
  channelType: number;
  prefix: string;
  timeoutMs?: number;
}): Promise<string[]> {
  if (opts.channelType !== CHANNEL_TYPES.ANTHROPIC || !opts.apiKey) return [];
  const claude = opts.models.filter((m) => makerForModel(m) === "anthropic");
  if (claude.length === 0) return [];
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.MODEL_TEST_MS;
  const gate = getConcurrencyGate();
  const failed = await Promise.all(
    claude.map((model) =>
      gate.run(opts.baseUrl, async (): Promise<string | null> => {
        throwIfRunAborted();
        const key = passKey(opts.prefix, model);
        if (passingByKey.has(key)) return null;
        const blacklistKey = `${opts.prefix}|${model}`;
        if (isAuthenticityBlacklisted(blacklistKey)) return model;
        if (isAuthenticityPassCached(blacklistKey, opts.baseUrl)) return null;
        const run = await runAuthenticity({
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          model,
          maker: "anthropic",
          timeoutMs,
          logKey: blacklistKey,
          wire: "anthropic",
          ladder: true,
          fingerprint: false,
        });
        if (run.authentic !== false) return null;
        const http: TestExchange = {
          pass: false,
          request: { url: "", headers: {}, body: null },
          response: null,
          responseHeaders: {},
          error: t("CORE.TESTER.ERR_AUTHENTICITY_BLACKLISTED"),
        };
        addTestResult({
          provider: opts.prefix,
          model,
          cost: null,
          http,
          stream: null,
          toolCall: null,
          authentic: false,
        });
        return model;
      }),
    ),
  );
  return failed.filter((m): m is string => m !== null);
}

export async function testAndFilterModels(opts: {
  allModels: string[];
  baseUrl: string;
  apiKey: string;
  apiKeyFor?: (model: string) => string | undefined;
  channelType: number;
  providerLabel: string;
  testableModelTypes: Set<ModelType>;
  modelEndpoints?: Map<string, string[]>;
  useResponsesAPI?: boolean;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy<TestExchange>;
  acceptRateLimited?: boolean | ((model: string) => boolean);
  skipAuthenticity?: boolean;
  capabilities?: Map<string, ModelCapabilityHint>;
  /** Merged into every probe body: a marketplace seller pin (`provider`). */
  extraBody?: Record<string, unknown>;
  /** Sent on every probe: a marketplace bid (`x-max-input-price`). */
  extraHeaders?: Record<string, string>;
  /** Probe id to model family, for ids that carry a routing prefix
   *  (`<pool>/claude-opus-5`); the maker is read off the family. */
  familyOf?: (model: string) => string;
}): Promise<{
  workingModels: string[];
  rateLimitedModels: string[];
  testedCount: number;
  details?: ModelTestDetail[];
}> {
  const provider = opts.providerLabel;
  // Dry-run: no upstream requests. Every model is reported working so pricing +
  // diff compute against the full candidate set.
  if (dryRunMode) {
    return {
      workingModels: opts.allModels,
      rateLimitedModels: [],
      testedCount: 0,
      details: undefined,
    };
  }
  const testableModels = opts.allModels.filter((m) => {
    const mt = inferModelType(m, undefined, opts.modelEndpoints);
    if (mt !== "text" && opts.testableModelTypes.has(mt)) return true;
    return isTestableModel(m, undefined, opts.modelEndpoints);
  });
  const nonTestableModels = opts.allModels.filter(
    (m) => !testableModels.includes(m),
  );

  let testedWorkingModels: string[] = [];
  let rateLimitedModels: string[] = [];
  let details: ModelTestDetail[] | undefined;

  if (opts.testableModelTypes.size === 0) {
    testedWorkingModels = testableModels;
    consola.info(
      t("CORE.TESTER.MODELS_TESTING_SKIPPED", {
        provider,
        count: testableModels.length,
      }),
    );
  } else if ((opts.apiKey || opts.apiKeyFor) && testableModels.length > 0) {
    const testResult = await testModels({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      apiKeyFor: opts.apiKeyFor,
      models: testableModels,
      channelType: opts.channelType,
      useResponsesAPI: opts.useResponsesAPI,
      timeoutMs: opts.timeoutMs,
      modelEndpoints: opts.modelEndpoints,
      logPrefix: provider,
      retryPolicy: opts.retryPolicy,
      acceptRateLimited: opts.acceptRateLimited,
      capabilities: opts.capabilities,
      skipAuthenticity: opts.skipAuthenticity,
      extraBody: opts.extraBody,
      extraHeaders: opts.extraHeaders,
      familyOf: opts.familyOf,
    });
    testedWorkingModels = testResult.workingModels;
    rateLimitedModels = testResult.rateLimitedModels;
    details = testResult.details;

    const failed = testResult.details.filter(
      (d) =>
        !d.success || d.streamSuccess === false || d.toolCallSuccess === false,
    );
    if (failed.length > 0) {
      const g = (v: boolean | null) =>
        v === false ? "x" : v === null ? "." : "v";
      const labeled = failed
        .map(
          (d) =>
            `${d.model} ${d.success ? "v" : "x"}H ${g(d.streamSuccess)}S ${g(d.toolCallSuccess)}T`,
        )
        .join(", ");
      consola.info(
        t("CORE.TESTER.PROVIDER_FAILED", { provider, models: labeled }),
      );
    }
  }

  return {
    workingModels: [...testedWorkingModels, ...nonTestableModels],
    rateLimitedModels,
    testedCount: testableModels.length,
    details,
  };
}
