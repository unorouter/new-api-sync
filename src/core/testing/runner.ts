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
  saveAuthenticityBlacklist,
  testAnthropicAuthenticity,
} from "./authenticity";
import {
  testRequest,
  testStreamRequest,
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

const testReport: TestReport = {
  timestamp: new Date().toISOString(),
  providers: {},
  modelTests: [],
};
const passingByKey = new Map<string, ModelTestLog>();
const passKey = (provider: string, model: string) => `${provider}|${model}`;

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
  saveAuthenticityBlacklist();
  if (testReport.modelTests.length === 0) return;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logsDir, `${ts}-model-tests.json`);
  writeFileSync(path, JSON.stringify(redactedReport(), null, 2));
  consola.info(t("CORE.TESTER.REPORT_WRITTEN", { path }));
}

function isToolChoiceUnsupportedError(r: TestExchange): boolean {
  if (r.status !== undefined && r.status < 400) return false;
  const parts: string[] = [];
  if (typeof r.error === "string") parts.push(r.error);
  if (typeof r.response === "string") parts.push(r.response);
  else if (r.response && typeof r.response === "object")
    parts.push(JSON.stringify(r.response));
  const blob = parts.join(" ").toLowerCase();
  return (
    blob.includes("tool_choice") &&
    (blob.includes("not support") ||
      blob.includes("unsupported") ||
      blob.includes("not allowed"))
  );
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
const mkDetail = (model: string, channelType: number, success: boolean, streamSuccess: boolean | null, toolCallSuccess: boolean | null, authenticityProbed: boolean, httpStatus?: number): ModelTestDetail => ({ model, success, streamSuccess, toolCallSuccess, authenticityProbed, channelType, ...(httpStatus !== undefined && { httpStatus }) });

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
  acceptRateLimited?: boolean;
  capabilities?: Map<string, ModelCapabilityHint>;
}): Promise<{ workingModels: string[]; details: ModelTestDetail[] }> {
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
            false,
          );

        const blacklistKey = `${prefix}|${model}`;
        const isClaude = model.startsWith("claude-");
        if (
          opts.channelType === CHANNEL_TYPES.ANTHROPIC &&
          isClaude &&
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
          return mkDetail(model, opts.channelType, false, null, null, false);
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
        const streamConfig = isText ? getStreamRequestConfig(reqOpts) : null;
        const toolCfg = isText
          ? getToolCallConfig(reqOpts, opts.capabilities?.get(model))
          : null;
        const retry = (fn: () => Promise<TestExchange>) =>
          withRetry(fn, (r) => r.pass, opts.retryPolicy);
        const [httpResult, streamResult, toolResult] = await Promise.all([
          retry(() =>
            testRequest(HTTP_CONFIG_BY_TYPE[modelType](reqOpts), timeoutMs),
          ),
          streamConfig
            ? retry(() => testStreamRequest(streamConfig, timeoutMs))
            : null,
          toolCfg ? retry(() => testRequest(toolCfg, timeoutMs)) : null,
        ]);
        const success = httpResult.pass;
        const streamSuccess = streamResult?.pass ?? null;
        const toolCallSuccess: boolean | null =
          toolResult === null
            ? null
            : toolResult.pass
              ? true
              : isToolChoiceUnsupportedError(toolResult)
                ? null
                : false;

        let authentic = true;
        if (isClaude && (success || streamSuccess)) {
          authentic = await testAnthropicAuthenticity({
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
          isClaude && (success || streamSuccess === true),
          httpResult.status,
        );
      }),
    ),
  );

  return {
    workingModels: results
      .filter(
        (r) =>
          r.success ||
          r.streamSuccess === true ||
          (opts.acceptRateLimited === true && r.httpStatus === 429),
      )
      .map((r) => r.model),
    details: results,
  };
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
  retryPolicy?: RetryPolicy<TestExchange>;
  acceptRateLimited?: boolean;
  capabilities?: Map<string, ModelCapabilityHint>;
}): Promise<{
  workingModels: string[];
  testedCount: number;
  details?: ModelTestDetail[];
}> {
  const provider = opts.providerLabel;
  const testableModels = opts.allModels.filter((m) => {
    const mt = inferModelType(m, undefined, opts.modelEndpoints);
    if (mt !== "text" && opts.testableModelTypes.has(mt)) return true;
    return isTestableModel(m, undefined, opts.modelEndpoints);
  });
  const nonTestableModels = opts.allModels.filter(
    (m) => !testableModels.includes(m),
  );

  let testedWorkingModels: string[] = [];
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
      modelEndpoints: opts.modelEndpoints,
      logPrefix: provider,
      retryPolicy: opts.retryPolicy,
      acceptRateLimited: opts.acceptRateLimited,
      capabilities: opts.capabilities,
    });
    testedWorkingModels = testResult.workingModels;
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
    testedCount: testableModels.length,
    details,
  };
}
