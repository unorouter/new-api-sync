import { throwIfRunAborted } from "@core/runtime/abort";
import {
  CHANNEL_TYPES,
  inferModelType,
  isTestableModel,
  TIMEOUTS,
} from "@core/models/constants";
import type { ModelType } from "@core/models/types";
import { logTestSummary } from "@core/models/test-log";
import { t } from "@server/i18n";
import { consola } from "consola";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  withRetry,
  testRequest,
  testStreamRequest,
  testToolCall,
} from "./execution";
import {
  testAnthropicAuthenticity,
  isKiroBlacklisted,
  kiroProbeAccumulator,
  loadKiroBlacklist,
  saveKiroBlacklist,
} from "./kiro";
import {
  getRequestConfig,
  getStreamRequestConfig,
  getToolCallConfig,
  getImageTestConfig,
  getVideoTestConfig,
  getEmbeddingTestConfig,
  getAudioTestConfig,
} from "./request-configs";
import type {
  ModelTestDetail,
  ModelTestLog,
  ModelRequestOpts,
  TestExchange,
  TestReport,
} from "./types";

// ---------------------------------------------------------------------------
// Redaction — strip auth secrets before writing to disk
// ---------------------------------------------------------------------------

const SENSITIVE_HEADERS = ["authorization", "x-api-key"];

function redactUrl(url: string): string {
  return url.replace(/([?&])key=[^&]+/g, "$1key=[REDACTED]");
}

function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k in headers) {
    out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase())
      ? "[REDACTED]"
      : headers[k]!;
  }
  return out;
}

function redactExchange(ex: TestExchange): TestExchange {
  return {
    ...ex,
    request: {
      url: redactUrl(ex.request.url),
      headers: redactHeaders(ex.request.headers),
      body: ex.request.body,
    },
  };
}

function redactResult(entry: ModelTestLog): ModelTestLog {
  return {
    ...entry,
    http: redactExchange(entry.http),
    stream: entry.stream ? redactExchange(entry.stream) : null,
    toolCall: entry.toolCall ? redactExchange(entry.toolCall) : null,
  };
}

function redactedReport(): TestReport {
  return {
    timestamp: testReport.timestamp,
    results: testReport.results.map(redactResult),
  };
}

// ---------------------------------------------------------------------------
// Test report accumulator (module-level state)
// ---------------------------------------------------------------------------

const testReport: TestReport = {
  timestamp: new Date().toISOString(),
  results: [],
};

function addTestResult(entry: ModelTestLog): void {
  const key = `${entry.provider}|${entry.model}`;
  entry.kiroProbes = kiroProbeAccumulator.get(key);
  testReport.results.push(entry);
}

export function recordTestResult(entry: {
  provider: string;
  model: string;
  http: TestExchange;
  stream?: TestExchange | null;
  toolCall?: TestExchange | null;
}): void {
  addTestResult({
    provider: entry.provider,
    model: entry.model,
    cost: null,
    http: entry.http,
    stream: entry.stream ?? null,
    toolCall: entry.toolCall ?? null,
    authentic: null,
  });
}

export function setTestCost(
  provider: string,
  model: string,
  cost: number,
): void {
  const entry = testReport.results.find(
    (r) => r.provider === provider && r.model === model,
  );
  if (entry) entry.cost = cost;
}

// ---------------------------------------------------------------------------
// Test report I/O
// ---------------------------------------------------------------------------

export function writeTestReport(): void {
  saveKiroBlacklist();
  if (testReport.results.length === 0) return;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logsDir, `${ts}-model-tests.json`);
  writeFileSync(path, JSON.stringify(redactedReport(), null, 2));
  consola.info(t("CORE.TESTER.REPORT_WRITTEN", { path }));
}

export function initTestReportForDate(): void {
  const today = new Date().toISOString().slice(0, 10);
  const path = join(process.cwd(), "logs", `${today}-model-tests.json`);
  try {
    const raw = readFileSync(path, "utf8");
    const existing = JSON.parse(raw) as TestReport;
    testReport.results = existing.results.filter((r) => r.http.pass);
    consola.info(
      t("CORE.TESTER.REPORT_RESUMED", {
        path,
        count: testReport.results.length,
      }),
    );
  } catch {
    // File doesn't exist yet — start fresh
  }
  loadKiroBlacklist();
}

export function writeTestReportForDate(): void {
  saveKiroBlacklist();
  if (testReport.results.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const path = join(logsDir, `${today}-model-tests.json`);
  writeFileSync(path, JSON.stringify(redactedReport(), null, 2));
  consola.info(
    t("CORE.TESTER.REPORT_WRITTEN_COUNT", {
      path,
      count: testReport.results.length,
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
  onModelTested?: (detail: ModelTestDetail) => void | Promise<void>;
}): Promise<{
  workingModels: string[];
  details: ModelTestDetail[];
}> {
  const baseUrl = opts.baseUrl;
  const apiKey = opts.apiKey;
  const models = opts.models;
  const channelType = opts.channelType;
  const useResponsesAPI = opts.useResponsesAPI ?? false;
  const concurrency = opts.concurrency ?? 5;
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.MODEL_TEST_MS;
  const onModelTested = opts.onModelTested;
  const prefix = opts.logPrefix ?? "unknown";

  const results: ModelTestDetail[] = [];

  for (let i = 0; i < models.length; i += concurrency) {
    throwIfRunAborted();
    const batch = models.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const existingPass = testReport.results.find(
          (r) => r.provider === prefix && r.model === model && r.http.pass,
        );
        if (existingPass) {
          consola.debug(t("CORE.TESTER.ALREADY_PASSED", { prefix, model }));
          return {
            model,
            success: true,
            streamSuccess: existingPass.stream?.pass ?? null,
            toolCallSuccess: existingPass.toolCall?.pass ?? null,
            kiroProbed: false,
          };
        }

        const blacklistKey = `${prefix}|${model}`;
        if (
          channelType === CHANNEL_TYPES.ANTHROPIC &&
          model.startsWith("claude-") &&
          isKiroBlacklisted(blacklistKey)
        ) {
          consola.debug(
            t("CORE.TESTER.KIRO_BLACKLISTED", { prefix, model }),
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
              error: t("CORE.TESTER.ERR_KIRO_BLACKLISTED"),
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
            kiroProbed: false,
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

        let httpResult: TestExchange;
        if (modelType === "image") {
          httpResult = await withRetry(
            () => testRequest(getImageTestConfig(reqOpts), timeoutMs),
            (r) => r.pass,
          );
        } else if (modelType === "video") {
          httpResult = await withRetry(
            () => testRequest(getVideoTestConfig(reqOpts), timeoutMs),
            (r) => r.pass,
          );
        } else if (modelType === "embedding") {
          httpResult = await withRetry(
            () => testRequest(getEmbeddingTestConfig(reqOpts), timeoutMs),
            (r) => r.pass,
          );
        } else if (modelType === "audio") {
          httpResult = await withRetry(
            () => testRequest(getAudioTestConfig(reqOpts), timeoutMs),
            (r) => r.pass,
          );
        } else {
          httpResult = await withRetry(
            () => testRequest(getRequestConfig(reqOpts), timeoutMs),
            (r) => r.pass,
          );
        }
        const success = httpResult.pass;

        const streamConfig = isNonTextModel
          ? null
          : getStreamRequestConfig(reqOpts);
        const streamResult = streamConfig
          ? await withRetry(
              () => testStreamRequest(streamConfig, timeoutMs),
              (r) => r.pass,
            )
          : null;
        const streamSuccess = streamResult?.pass ?? null;

        const toolCallConfig = isNonTextModel
          ? null
          : getToolCallConfig(reqOpts);
        const toolResult =
          (success || streamSuccess) && toolCallConfig
            ? await withRetry(
                () => testToolCall(toolCallConfig, timeoutMs),
                (r) => r.pass,
              )
            : null;
        const toolCallSuccess = toolResult?.pass ?? null;

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
          kiroProbed:
            model.startsWith("claude-") &&
            (success || streamSuccess === true),
        };
      }),
    );
    results.push(...batchResults);
    if (onModelTested) {
      for (const detail of batchResults) {
        await onModelTested(detail);
      }
    }
  }

  return {
    workingModels: results
      .filter((r) => r.success || r.streamSuccess === true)
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
  onModelTested?: (detail: ModelTestDetail) => void | Promise<void>;
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
    `[${opts.providerLabel}] Testable (${testableModels.length}): ${testableModels.join(", ") || "(none)"}`,
  );
  if (nonTestableModels.length > 0) {
    consola.debug(
      `[${opts.providerLabel}] Non-testable (${nonTestableModels.length}): ${nonTestableModels.join(", ")}`,
    );
  }

  let testedWorkingModels: string[] = [];
  let details: ModelTestDetail[] | undefined;

  if (skipTesting) {
    testedWorkingModels = testableModels;
    consola.info(
      `[${opts.providerLabel}] ${testableModels.length} models (testing skipped)`,
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
      onModelTested: opts.onModelTested,
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
    consola.info(
      `[${opts.providerLabel}] Included without test: ${nonTestableModels.join(", ")}`,
    );
  }

  return {
    workingModels,
    testedCount: testableModels.length,
    details,
  };
}
