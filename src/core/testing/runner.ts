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
  testToolCall,
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

function redactResult(entry: ModelTestLog): ModelTestLog {
  return {
    ...entry,
    http: redactExchange(entry.http),
    stream: entry.stream ? redactExchange(entry.stream) : null,
    toolCall: entry.toolCall ? redactExchange(entry.toolCall) : null,
    authenticityProbes: entry.authenticityProbes?.map((p) => ({
      ...p,
      request: { ...p.request, url: redactUrl(p.request.url) },
    })),
  };
}

function redactedReport(): TestReport {
  return {
    timestamp: testReport.timestamp,
    providers: testReport.providers,
    summary: testReport.summary,
    modelTests: testReport.modelTests.map(redactResult),
    pricingGate:
      testReport.pricingGate && testReport.pricingGate.length > 0
        ? testReport.pricingGate
        : undefined,
    openrouterEndpoints:
      testReport.openrouterEndpoints &&
      testReport.openrouterEndpoints.length > 0
        ? testReport.openrouterEndpoints
        : undefined,
  };
}

// ─── Test report accumulator (module state) ────────────────────────────────

const testReport: TestReport = {
  timestamp: new Date().toISOString(),
  providers: {},
  modelTests: [],
};

// O(1) "already-tested" lookups; without this testModels is O(N²) on large syncs.
const passingByKey = new Map<string, ModelTestLog>();

function passKey(provider: string, model: string): string {
  return `${provider}|${model}`;
}

function addTestResult(entry: ModelTestLog): void {
  const key = passKey(entry.provider, entry.model);
  entry.authenticityProbes = authenticityProbeAccumulator.get(key);
  testReport.modelTests.push(entry);
  if (entry.http.pass) passingByKey.set(key, entry);
}

function ensureProviderEntry(provider: string): ProviderCostEntry {
  let entry = testReport.providers[provider];
  if (!entry) {
    entry = {};
    testReport.providers[provider] = entry;
  }
  return entry;
}

/** Last-writer wins. */
export function recordProviderCost(provider: string, testCost: number): void {
  ensureProviderEntry(provider).testCost = testCost;
}

/** Mirrors what printRunSummary writes to stdout; call before writeTestReport. */
export function recordRunSummary(input: {
  providerReports: ProviderReport[];
  apply: ApplyReport;
  diff: SyncDiff;
  elapsedMs: number;
  success: boolean;
}): void {
  for (const report of input.providerReports) {
    const entry = ensureProviderEntry(report.name);
    entry.success = report.success;
    if (report.error) entry.error = report.error;
    entry.groups = report.groups;
    entry.models = report.models;
    entry.tokens = report.tokens;
  }

  // Bucket by tag so per-provider deltas concat back to the global lists.
  const channelTagByName = new Map<string, string>();
  for (const op of input.diff.channels) {
    const channel = op.type === "delete" ? op.existing : op.value;
    if (channel.tag) channelTagByName.set(channel.name, channel.tag);
  }
  const bucketBy = (
    op: "created" | "updated" | "deleted",
    keys: string[],
  ): void => {
    for (const key of keys) {
      const tag = channelTagByName.get(key);
      if (!tag) continue;
      const entry = ensureProviderEntry(tag);
      if (!entry.channels) {
        entry.channels = { created: [], updated: [], deleted: [] };
      }
      entry.channels[op].push(key);
    }
  };
  bucketBy("created", input.apply.channels.created);
  bucketBy("updated", input.apply.channels.updated);
  bucketBy("deleted", input.apply.channels.deleted);

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

/** Deduped by exposed name — the vote is a global model property. */
export function recordPricingGate(entry: PricingGateLog): void {
  if (!testReport.pricingGate) testReport.pricingGate = [];
  if (testReport.pricingGate.some((e) => e.exposed === entry.exposed)) return;
  testReport.pricingGate.push(entry);
}

/** Audit trail for actually-tested models, not all 370 in the prefetch. Deduped by id. */
export function recordOpenRouterEndpointsForModel(
  entry: OpenRouterEndpointsLog,
): void {
  if (!testReport.openrouterEndpoints) testReport.openrouterEndpoints = [];
  if (testReport.openrouterEndpoints.some((e) => e.id === entry.id)) return;
  testReport.openrouterEndpoints.push(entry);
}

// ─── Test report I/O ───────────────────────────────────────────────────────

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

// ─── Tool-call error classification ────────────────────────────────────────

/** Reasoning-only models reject tool_choice but still pass HTTP+Stream. Detect by message (generalises to future models). */
function isToolChoiceUnsupportedError(result: TestExchange): boolean {
  const status = result.status;
  if (status !== undefined && status < 400) return false;
  const haystacks: string[] = [];
  if (typeof result.error === "string") haystacks.push(result.error);
  if (typeof result.response === "string") haystacks.push(result.response);
  else if (result.response && typeof result.response === "object") {
    haystacks.push(JSON.stringify(result.response));
  }
  const blob = haystacks.join(" ").toLowerCase();
  if (!blob.includes("tool_choice")) return false;
  return (
    blob.includes("not support") ||
    blob.includes("unsupported") ||
    blob.includes("not allowed")
  );
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface ModelCapabilityHint {
  supportsTools?: boolean;
  isReasoning?: boolean;
}

export async function testModels(opts: {
  baseUrl: string;
  apiKey: string;
  models: string[];
  channelType: number;
  useResponsesAPI?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  logPrefix?: string;
  modelEndpoints?: Map<string, string[]>;
  /** Default 2 attempts, retry-any. NVIDIA passes NVIDIA_RETRY_POLICY. */
  retryPolicy?: RetryPolicy<TestExchange>;
  /** Keep 429 models (OpenRouter free-tier: daily quota exhausted ≠ broken). */
  acceptRateLimited?: boolean;
  /**
   * Per-model capability hints from external pricing metadata
   * (LiteLLM/OpenRouter/basellm). Used to skip the tool-call probe for
   * reasoning-only or tools-unsupported models before paying the request.
   */
  capabilities?: Map<string, ModelCapabilityHint>;
}): Promise<{
  workingModels: string[];
  details: ModelTestDetail[];
}> {
  const baseUrl = opts.baseUrl;
  const apiKey = opts.apiKey;
  const models = opts.models;
  const channelType = opts.channelType;
  const useResponsesAPI = opts.useResponsesAPI ?? false;
  const retryPolicy = opts.retryPolicy;
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.MODEL_TEST_MS;
  const prefix = opts.logPrefix ?? "unknown";
  const gate = getConcurrencyGate();

  // All models run as a single Promise.all; the shared ConcurrencyGate
  // enforces both the global cap and the per-upstream cap. opts.concurrency
  // is intentionally ignored now — the gate is the only knob.
  void opts.concurrency;

  const results: ModelTestDetail[] = await Promise.all(
    models.map((model) =>
      gate.run(baseUrl, async () => {
        throwIfRunAborted();
        const existingPass = passingByKey.get(passKey(prefix, model));
        if (existingPass) {
          consola.debug(t("CORE.TESTER.ALREADY_PASSED", { prefix, model }));
          return {
            model,
            success: true,
            streamSuccess: existingPass.stream?.pass ?? null,
            toolCallSuccess: existingPass.toolCall?.pass ?? null,
            authenticityProbed: false,
            channelType,
          };
        }

        const blacklistKey = `${prefix}|${model}`;
        if (
          channelType === CHANNEL_TYPES.ANTHROPIC &&
          model.startsWith("claude-") &&
          isAuthenticityBlacklisted(blacklistKey)
        ) {
          consola.debug(
            t("CORE.TESTER.AUTHENTICITY_BLACKLISTED", { prefix, model }),
          );
          addTestResult({
            provider: prefix,
            model,
            cost: null,
            http: {
              pass: false,
              request: { url: "", headers: {}, body: null },
              response: null,
              responseHeaders: {},
              error: t("CORE.TESTER.ERR_AUTHENTICITY_BLACKLISTED"),
            },
            stream: null,
            toolCall: null,
            authentic: false,
          });
          return {
            model,
            success: false,
            streamSuccess: null,
            toolCallSuccess: null,
            authenticityProbed: false,
            channelType,
          };
        }

        const reqOpts: ModelRequestOpts = {
          baseUrl,
          apiKey,
          model,
          channelType,
          useResponsesAPI,
        };

        const modelType = inferModelType(model, undefined, opts.modelEndpoints);
        const isNonTextModel = modelType !== "text";

        // Text: HTTP/stream/tool fire in parallel. Non-text: HTTP only.
        const httpConfigByType = {
          image: getImageTestConfig,
          video: getVideoTestConfig,
          embedding: getEmbeddingTestConfig,
          audio: getAudioTestConfig,
          text: getRequestConfig,
        } as const;
        const httpConfig = httpConfigByType[modelType](reqOpts);

        const streamConfig = isNonTextModel
          ? null
          : getStreamRequestConfig(reqOpts);
        const toolCallConfig = isNonTextModel
          ? null
          : getToolCallConfig(reqOpts, opts.capabilities?.get(model));

        const [httpResult, streamResult, toolResult] = await Promise.all([
          withRetry(
            () => testRequest(httpConfig, timeoutMs),
            (r) => r.pass,
            retryPolicy,
          ),
          streamConfig
            ? withRetry(
                () => testStreamRequest(streamConfig, timeoutMs),
                (r) => r.pass,
                retryPolicy,
              )
            : Promise.resolve(null as TestExchange | null),
          toolCallConfig
            ? withRetry(
                () => testToolCall(toolCallConfig, timeoutMs),
                (r) => r.pass,
                retryPolicy,
              )
            : Promise.resolve(null as TestExchange | null),
        ]);
        const success = httpResult.pass;
        const streamSuccess = streamResult?.pass ?? null;
        // tool_choice rejection: mark null (n/a) so the model isn't failed on HTTP+Stream.
        const toolCallSuccess: boolean | null = (() => {
          if (toolResult === null) return null;
          if (toolResult.pass) return true;
          if (isToolChoiceUnsupportedError(toolResult)) return null;
          return false;
        })();

        let authentic = true;
        const logKey = `${prefix}|${model}`;
        if (model.startsWith("claude-") && (success || streamSuccess)) {
          authentic = await testAnthropicAuthenticity({
            baseUrl,
            apiKey,
            model,
            timeoutMs,
            logKey,
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
          authentic: model.startsWith("claude-") ? authentic : null,
        });

        logTestSummary({
          prefix,
          model,
          modelType,
          http: {
            pass: finalSuccess,
            status: httpResult.status,
            latencyMs: httpResult.latencyMs,
            error: httpResult.error,
            body: httpResult.response,
          },
          stream:
            streamResult === null
              ? undefined
              : {
                  pass: finalStream === true,
                  status: streamResult.status,
                  latencyMs: streamResult.latencyMs,
                  error: streamResult.error,
                  body: streamResult.response,
                },
          tool:
            toolResult === null
              ? undefined
              : {
                  pass: toolCallSuccess === true,
                  status: toolResult.status,
                  latencyMs: toolResult.latencyMs,
                  error: toolResult.error,
                  body: toolResult.response,
                },
        });

        return {
          model,
          success: finalSuccess,
          streamSuccess: finalStream,
          toolCallSuccess,
          authenticityProbed:
            model.startsWith("claude-") && (success || streamSuccess === true),
          httpStatus: httpResult.status,
          channelType,
        };
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
  /** Passed through to `testModels` for providers that need custom retry. */
  retryPolicy?: RetryPolicy<TestExchange>;
  /** Passed through to `testModels`. See `testModels.acceptRateLimited`. */
  acceptRateLimited?: boolean;
  /** Passed through to `testModels`. See `testModels.capabilities`. */
  capabilities?: Map<string, ModelCapabilityHint>;
}): Promise<{
  workingModels: string[];
  testedCount: number;
  details?: ModelTestDetail[];
}> {
  const skipTesting = opts.testableModelTypes.size === 0;

  const testableModels = opts.allModels.filter((m) => {
    const modelType = inferModelType(m, undefined, opts.modelEndpoints);
    if (modelType !== "text" && opts.testableModelTypes.has(modelType))
      return true;
    return isTestableModel(m, undefined, opts.modelEndpoints);
  });
  const nonTestableModels = opts.allModels.filter(
    (m) => !testableModels.includes(m),
  );

  consola.debug(
    t("CORE.TESTER.TESTABLE_COUNT", {
      provider: opts.providerLabel,
      testable: testableModels.length,
      nonTestable: nonTestableModels.length,
    }),
  );
  consola.trace(
    t("CORE.TESTER.TESTABLE_LIST", {
      provider: opts.providerLabel,
      models: testableModels.join(", ") || "(none)",
    }),
  );
  if (nonTestableModels.length > 0) {
    consola.trace(
      t("CORE.TESTER.NON_TESTABLE_LIST", {
        provider: opts.providerLabel,
        models: nonTestableModels.join(", "),
      }),
    );
  }

  let testedWorkingModels: string[] = [];
  let details: ModelTestDetail[] | undefined;

  if (skipTesting) {
    testedWorkingModels = testableModels;
    consola.info(
      t("CORE.TESTER.MODELS_TESTING_SKIPPED", {
        provider: opts.providerLabel,
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
      logPrefix: opts.providerLabel,
      retryPolicy: opts.retryPolicy,
      acceptRateLimited: opts.acceptRateLimited,
      capabilities: opts.capabilities,
    });
    testedWorkingModels = testResult.workingModels;
    details = testResult.details;

    const failedDetails = testResult.details.filter(
      (d) =>
        !d.success || d.streamSuccess === false || d.toolCallSuccess === false,
    );
    if (failedDetails.length > 0) {
      const labeled = failedDetails.map((d) => {
        const h = d.success ? "✓" : "✗";
        const s =
          d.streamSuccess === false
            ? "✗"
            : d.streamSuccess === null
              ? "·"
              : "✓";
        const tool =
          d.toolCallSuccess === false
            ? "✗"
            : d.toolCallSuccess === null
              ? "·"
              : "✓";
        return `${d.model} ${h}H ${s}S ${tool}T`;
      });
      consola.info(
        t("CORE.TESTER.PROVIDER_FAILED", {
          provider: opts.providerLabel,
          models: labeled.join(", "),
        }),
      );
    }
  }

  const workingModels = [...testedWorkingModels, ...nonTestableModels];

  if (nonTestableModels.length > 0) {
    consola.debug(
      t("CORE.TESTER.INCLUDED_NO_TEST", {
        provider: opts.providerLabel,
        count: nonTestableModels.length,
      }),
    );
    consola.trace(
      t("CORE.TESTER.INCLUDED_NO_TEST_LIST", {
        provider: opts.providerLabel,
        models: nonTestableModels.join(", "),
      }),
    );
  }

  return {
    workingModels,
    testedCount: testableModels.length,
    details,
  };
}
