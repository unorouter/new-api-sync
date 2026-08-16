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
import { consola } from "consola";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  authenticityProbeAccumulator,
  isAuthenticityBlacklisted,
  isAuthenticityPassCached,
  resetAuthenticityProbes,
  testAnthropicAuthenticity,
} from "./authenticity";
import {
  getVerdict,
  recordTestVerdict,
  saveVerdictCache,
  setAuthenticityVerdict,
} from "./verdict-cache";
import {
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

let testReport: TestReport = {
  timestamp: new Date().toISOString(),
  providers: {},
  modelTests: [],
};
const passingByKey = new Map<string, ModelTestLog>();
const passKey = (provider: string, model: string) => `${provider}|${model}`;

// Dry-run gate: when set, testAndFilterModels treats every testable model as
// working and sends no upstream requests (no cost). Set per run by runSync.
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

export function writeTestReport(): void {
  saveVerdictCache();
  if (testReport.modelTests.length === 0) return;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logsDir, `${ts}-model-tests.json`);
  writeFileSync(path, JSON.stringify(redactedReport(), null, 2));
  consola.info(t("CORE.TESTER.REPORT_WRITTEN", { path }));
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
function modelsMatch(requested: string, served: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[.]/g, "-");
  const a = norm(requested);
  const b = norm(served);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

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
const mkDetail = (model: string, channelType: number, success: boolean, streamSuccess: boolean | null, toolCallSuccess: boolean | null, toolParallel: boolean | null, authenticityProbed: boolean, httpStatus?: number, thinkingDetected?: boolean): ModelTestDetail => ({ model, success, streamSuccess, toolCallSuccess, toolParallel, authenticityProbed, channelType, ...(httpStatus !== undefined && { httpStatus }), ...(thinkingDetected && { thinkingDetected }) });

// A probe carried non-empty reasoning_content -> the model emits thinking. new-api bills a
// stream that produced ONLY reasoning_content (no content/tool_calls) as an empty 502, so such a
// channel needs thinking_to_content. Detected at probe time because "is this a thinking model" is
// not statically known (reasoning is often per-request, not a fixed model property).
function probeShowedReasoning(...exchanges: (TestExchange | null)[]): boolean {
  for (const ex of exchanges) {
    if (!ex) continue;
    const blob =
      typeof ex.response === "string"
        ? ex.response
        : JSON.stringify(ex.response ?? "");
    // match reasoning_content:"<non-empty>" (JSON) or reasoning_content in raw SSE text
    if (/"reasoning_content"\s*:\s*"[^"]/.test(blob)) return true;
  }
  return false;
}

async function testModels(opts: {
  baseUrl: string;
  apiKey: string;
  models: string[];
  channelType: number;
  useResponsesAPI?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  logPrefix?: string;
  modelEndpoints?: Map<string, string[]>;
  retryPolicy?: RetryPolicy<TestExchange>;
  acceptRateLimited?: boolean | ((model: string) => boolean);
  // Set only for a hand-verified first-party Claude whose upstream persona
  // trips the probe; see skipAuthenticity in validations/config.ts.
  skipAuthenticity?: boolean;
  capabilities?: Map<string, ModelCapabilityHint>;
}): Promise<{
  workingModels: string[];
  rateLimitedModels: string[];
  details: ModelTestDetail[];
}> {
  const useResponsesAPI = opts.useResponsesAPI ?? false;
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
        const isClaude = model.startsWith("claude-");
        if (
          opts.channelType === CHANNEL_TYPES.ANTHROPIC &&
          isClaude &&
          !opts.skipAuthenticity &&
          isAuthenticityBlacklisted(blacklistKey)
        ) {
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
          apiKey: opts.apiKey,
          model,
          channelType: opts.channelType,
          useResponsesAPI,
        };
        const modelType = inferModelType(model, undefined, opts.modelEndpoints);
        const isText = modelType === "text";

        // Permanent verdict reuse (logs/verdict-cache.json): a pair with a recorded
        // pass is never re-probed; force a retest by deleting its entry. Claude pairs
        // additionally require a cached authenticity pass. Text pairs without a
        // definitive tool verdict fall through so the tool probe can complete them.
        const cached = getVerdict(blacklistKey);
        const cachedTool =
          cached && cached.toolCallSuccess != null
            ? {
                pass: cached.toolCallSuccess,
                parallel: cached.toolParallel ?? null,
              }
            : null;
        if (
          cached?.success &&
          (!isText || cachedTool) &&
          (!isClaude || cached.authenticity === "pass")
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

        const streamConfig = isText ? getStreamRequestConfig(reqOpts) : null;
        const toolCfg =
          isText && !cachedTool
            ? getToolCallConfig(reqOpts, opts.capabilities?.get(model))
            : null;
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
            testRequest(HTTP_CONFIG_BY_TYPE[modelType](reqOpts), timeoutMs),
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
        const substituted = served !== null && !modelsMatch(model, served);
        if (substituted) {
          consola.warn(
            `[${prefix}] ${model}: ${t("CORE.TESTER.ERR_MODEL_SUBSTITUTED", { got: served })}`,
          );
          setAuthenticityVerdict(blacklistKey, "fail", `substituted:${served}`);
        }

        const success = httpResult.pass && !substituted;
        const streamSuccess =
          streamResult === null ? null : streamResult.pass && !substituted;
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

        let authentic = true;
        if (isClaude && !opts.skipAuthenticity && (success || streamSuccess)) {
          // A cached pass verdict means the 4 generative probes were already paid
          // for; trust it until the entry is manually pruned.
          authentic = isAuthenticityPassCached(blacklistKey)
            ? true
            : await testAnthropicAuthenticity({
                baseUrl: opts.baseUrl,
                apiKey: opts.apiKey,
                model,
                timeoutMs,
                logKey: blacklistKey,
              });
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
        });

        addTestResult({
          provider: prefix,
          model,
          cost: null,
          http: httpResult,
          stream: streamResult,
          toolCall: toolResult,
          authentic: isClaude ? authentic : null,
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
          isClaude && (success || streamSuccess === true),
          httpResult.status,
          probeShowedReasoning(httpResult, streamResult),
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
  const acceptedTransient = (r: (typeof results)[number]) =>
    r.httpStatus != null &&
    TRANSIENT_STATUS.has(r.httpStatus) &&
    !reallyPassed(r) &&
    acceptsTransient(r.model);

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
  const claude = opts.models.filter((m) => m.startsWith("claude-"));
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
        if (isAuthenticityPassCached(blacklistKey)) return null;
        const authentic = await testAnthropicAuthenticity({
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          model,
          timeoutMs,
          logKey: blacklistKey,
        });
        if (authentic) return null;
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
  } else if (opts.apiKey && testableModels.length > 0) {
    const testResult = await testModels({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      models: testableModels,
      channelType: opts.channelType,
      useResponsesAPI: opts.useResponsesAPI,
      timeoutMs: opts.timeoutMs,
      modelEndpoints: opts.modelEndpoints,
      logPrefix: provider,
      retryPolicy: opts.retryPolicy,
      acceptRateLimited: opts.acceptRateLimited,
      capabilities: opts.capabilities,
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
