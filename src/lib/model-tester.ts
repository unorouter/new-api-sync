import { CHANNEL_TYPES, isTestableModel, TIMEOUTS } from "@/lib/constants";
import { fetchJson, tryFetchJson } from "@/lib/http";
import { consola } from "consola";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Test report types and accumulator
// ---------------------------------------------------------------------------

interface TestExchange {
  pass: boolean;
  request: { url: string; body: unknown };
  response: unknown;
  error?: string;
}

interface KiroProbeLog {
  probe: string;
  pass: boolean;
  kiroRefusal: boolean;
  request: { url: string; body: unknown };
  response: string | null;
  error?: string;
}

interface ModelTestLog {
  provider: string;
  model: string;
  http: TestExchange;
  stream: TestExchange | null;
  toolCall: TestExchange | null;
  authentic: boolean | null;
  kiroProbes?: KiroProbeLog[];
}

interface TestReport {
  timestamp: string;
  results: ModelTestLog[];
}

const testReport: TestReport = {
  timestamp: new Date().toISOString(),
  results: []
};

const kiroProbeAccumulator = new Map<string, KiroProbeLog[]>();

function addKiroProbe(key: string, entry: KiroProbeLog): void {
  if (!kiroProbeAccumulator.has(key)) kiroProbeAccumulator.set(key, []);
  kiroProbeAccumulator.get(key)!.push(entry);
}

function addTestResult(entry: ModelTestLog): void {
  const key = `${entry.provider}|${entry.model}`;
  entry.kiroProbes = kiroProbeAccumulator.get(key);
  testReport.results.push(entry);
}

export function writeTestReport(): void {
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logsDir, `${ts}-model-tests.json`);
  writeFileSync(path, JSON.stringify(testReport, null, 2));
  consola.info(`[test-report] Written to ${path}`);
}

// ---------------------------------------------------------------------------
// Request config builders (unchanged logic, just building config objects)
// ---------------------------------------------------------------------------

interface RequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  isSuccess: (data: unknown) => boolean;
}

interface StreamRequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  completionMarker: string;
}

interface ToolCallRequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  isToolCallSuccess: (data: unknown) => boolean;
}

interface ModelRequestOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  channelType: number;
  useResponsesAPI: boolean;
}

function getRequestConfig(opts: ModelRequestOpts): RequestConfig {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
  const testPrompt = "Reply with only the word ok.";

  if (channelType === CHANNEL_TYPES.ANTHROPIC) {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: {
        model,
        messages: [{ role: "user", content: testPrompt }],
        max_tokens: 50
      },
      isSuccess: (data) => {
        const d = data as {
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
        if (d.type === "error") return false;
        const fullText = (d.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(" ")
          .toLowerCase();
        if (fullText.includes("kiro")) return false;
        return true;
      }
    };
  }
  if (channelType === CHANNEL_TYPES.GEMINI) {
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { "Content-Type": "application/json" },
      body: {
        contents: [{ parts: [{ text: testPrompt }] }],
        generationConfig: { maxOutputTokens: 3 }
      },
      isSuccess: (data) => !(data as { error?: unknown }).error
    };
  }
  if (useResponsesAPI) {
    return {
      url: `${baseUrl}/v1/responses`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: {
        model,
        input: [
          { role: "user", content: [{ type: "input_text", text: testPrompt }] }
        ],
        max_output_tokens: 3,
        store: false
      },
      isSuccess: (data) => !(data as { error?: unknown }).error
    };
  }
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: {
      model,
      messages: [{ role: "user", content: testPrompt }],
      max_tokens: 3
    },
    isSuccess: (data) => !(data as { error?: unknown }).error
  };
}

function getStreamRequestConfig(
  opts: ModelRequestOpts
): StreamRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
  const streamPrompt = "Reply with only the word ok.";

  if (channelType === CHANNEL_TYPES.ANTHROPIC) {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: {
        model,
        messages: [{ role: "user", content: streamPrompt }],
        max_tokens: 5,
        stream: true
      },
      completionMarker: "message_stop"
    };
  }
  if (channelType === CHANNEL_TYPES.GEMINI) {
    return null;
  }
  if (useResponsesAPI) {
    return null;
  }
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: {
      model,
      messages: [{ role: "user", content: streamPrompt }],
      max_tokens: 5,
      stream: true
    },
    completionMarker: "data: [DONE]"
  };
}

const TOOL_NAME = "calculator";
const TOOL_DESC = "Calculate a math expression";
const TOOL_PARAMS = {
  type: "object" as const,
  properties: {
    expression: { type: "string", description: "The math expression" }
  },
  required: ["expression"]
};
const TOOL_PROMPT = "What is 2+2? You must use the calculator tool to answer.";

function getToolCallConfig(
  opts: ModelRequestOpts
): ToolCallRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;

  if (useResponsesAPI) return null;
  if (model.endsWith("-thinking") || model.includes("-thinking-")) return null;

  if (channelType === CHANNEL_TYPES.ANTHROPIC) {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: {
        model,
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [
          { name: TOOL_NAME, description: TOOL_DESC, input_schema: TOOL_PARAMS }
        ],
        tool_choice: { type: "any" },
        max_tokens: 100
      },
      isToolCallSuccess: (data) => {
        const d = data as {
          stop_reason?: string;
          content?: Array<{ type?: string }>;
        };
        if (d.stop_reason === "tool_use") return true;
        return (
          Array.isArray(d.content) &&
          d.content.some((c) => c.type === "tool_use")
        );
      }
    };
  }

  if (channelType === CHANNEL_TYPES.GEMINI) {
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { "Content-Type": "application/json" },
      body: {
        contents: [{ parts: [{ text: TOOL_PROMPT }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: TOOL_NAME,
                description: TOOL_DESC,
                parameters: TOOL_PARAMS
              }
            ]
          }
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { maxOutputTokens: 100 }
      },
      isToolCallSuccess: (data) => {
        const d = data as {
          candidates?: Array<{
            content?: { parts?: Array<{ functionCall?: unknown }> };
          }>;
        };
        return (
          Array.isArray(d.candidates) &&
          d.candidates.some(
            (c) =>
              Array.isArray(c.content?.parts) &&
              c.content!.parts.some((p) => p.functionCall != null)
          )
        );
      }
    };
  }

  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: {
      model,
      messages: [{ role: "user", content: TOOL_PROMPT }],
      tools: [
        {
          type: "function",
          function: {
            name: TOOL_NAME,
            description: TOOL_DESC,
            parameters: TOOL_PARAMS
          }
        }
      ],
      tool_choice: "required",
      max_tokens: 100
    },
    isToolCallSuccess: (data) => {
      const d = data as {
        choices?: Array<{
          finish_reason?: string;
          message?: { tool_calls?: unknown[] };
        }>;
      };
      const choice = d.choices?.[0];
      if (!choice) return false;
      if (choice.finish_reason === "tool_calls") return true;
      return (choice.message?.tool_calls?.length ?? 0) > 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Test execution functions (return TestExchange with full request/response)
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, isPass: (v: T) => boolean): Promise<T> {
  const result = await fn();
  if (isPass(result)) return result;
  return fn();
}

async function testRequest(
  config: RequestConfig,
  timeoutMs: number
): Promise<TestExchange> {
  const data = await tryFetchJson<unknown>(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    timeoutMs
  });
  if (data === null) {
    return {
      pass: false,
      request: { url: config.url, body: config.body },
      response: null,
      error: "no response / timeout"
    };
  }
  return {
    pass: config.isSuccess(data),
    request: { url: config.url, body: config.body },
    response: data
  };
}

async function testStreamRequest(
  config: StreamRequestConfig,
  timeoutMs: number
): Promise<TestExchange> {
  const reqInfo = { url: config.url, body: config.body };
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(config.body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok || !response.body) {
      return {
        pass: false,
        request: reqInfo,
        response: null,
        error: `HTTP ${response.status}`
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let foundMarker = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (buffer.includes(config.completionMarker)) {
        foundMarker = true;
        reader.cancel();
        break;
      }

      if (buffer.startsWith("{") && buffer.includes('"error"')) {
        reader.cancel();
        return {
          pass: false,
          request: reqInfo,
          response: buffer.slice(0, 500),
          error: "error in stream"
        };
      }
    }

    return {
      pass: foundMarker,
      request: reqInfo,
      response: buffer.slice(0, 500)
    };
  } catch (err) {
    return {
      pass: false,
      request: reqInfo,
      response: null,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

async function testToolCall(
  config: ToolCallRequestConfig,
  timeoutMs: number
): Promise<TestExchange> {
  const data = await tryFetchJson<unknown>(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    timeoutMs
  });
  if (data === null) {
    return {
      pass: false,
      request: { url: config.url, body: config.body },
      response: null,
      error: "no response / timeout"
    };
  }
  return {
    pass: config.isToolCallSuccess(data),
    request: { url: config.url, body: config.body },
    response: data
  };
}

// ---------------------------------------------------------------------------
// Kiro model-substitution detection for Anthropic channels
// ---------------------------------------------------------------------------

const KIRO_REFUSAL_PATTERNS = [
  "i can't help with that",
  "i can't assist with that",
  "i can't discuss",
  "i cannot help with that",
  "i cannot assist with that",
  "assist with development",
  "here to assist with development tasks",
  "clarify my actual",
  "clarify my role",
  "need to clarify",
  "sensitive, personal, or emotional",
  "i'm here to help with coding",
  "i'm here to help with development",
  "i'm designed to help with development",
  "i'm focused on helping with",
  "programming and development",
  "let me help you with your code",
  "i'm a coding assistant",
  "technical task",
  "development tasks, writing, analysis",
  "infrastructure and configuration"
];

function hasKiroRefusal(text: string): boolean {
  return (
    text.includes("kiro") ||
    KIRO_REFUSAL_PATTERNS.some((p) => text.includes(p))
  );
}



type AnthropicResponse = {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function extractAnthropicText(data: unknown): string | null {
  const d = data as AnthropicResponse;
  if (d.type === "error") return null;
  return (d.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join(" ")
    .toLowerCase();
}

type ProbeResult = { pass: boolean; kiroRefusal: boolean };

async function runAnthropicProbe(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  label: string;
  maxTokens: number;
  evaluate: (text: string) => boolean;
  timeoutMs: number;
  logKey: string;
}): Promise<ProbeResult> {
  const reqBody = {
    model: opts.model,
    messages: [{ role: "user", content: opts.prompt }],
    max_tokens: opts.maxTokens
  };
  const reqUrl = `${opts.baseUrl}/v1/messages`;

  let data: unknown;
  try {
    data = await fetchJson<unknown>(reqUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: reqBody,
      timeoutMs: opts.timeoutMs
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addKiroProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      kiroRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: errMsg
    });
    return { pass: false, kiroRefusal: false };
  }

  const text = extractAnthropicText(data);
  if (text === null) {
    addKiroProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      kiroRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: `failed to extract text from response: ${JSON.stringify(data).slice(0, 300)}`
    });
    return { pass: false, kiroRefusal: false };
  }
  const refusal = hasKiroRefusal(text);
  const result = opts.evaluate(text);
  addKiroProbe(opts.logKey, {
    probe: opts.label,
    pass: result,
    kiroRefusal: refusal,
    request: { url: reqUrl, body: reqBody },
    response: text
  });
  return { pass: result, kiroRefusal: refusal };
}

/**
 * Multi-probe authenticity test for Anthropic models.
 * If ANY probe detects a Kiro refusal, the model fails immediately.
 * Otherwise, timeouts/errors are tolerated as long as 2/3 probes pass.
 */
async function testAnthropicAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  logKey: string;
}): Promise<boolean> {
  const [r1, r2, r3] = await Promise.all([
    // Probe 1: Emotional content
    // Kiro: "Never discuss sensitive, personal, or emotional topics"
    runAnthropicProbe({
      ...opts,
      label: "emotional",
      prompt: "Tell me a 2-sentence sad story about a lost kitten.",
      maxTokens: 150,
      evaluate: (text) => {
        if (hasKiroRefusal(text)) return false;
        return text.length >= 40;
      }
    }),
    // Probe 2: Non-dev creative task
    // Kiro is restricted to developer assistance
    runAnthropicProbe({
      ...opts,
      label: "creative",
      prompt:
        "Write a haiku about the ocean at sunrise. Only the haiku, nothing else.",
      maxTokens: 80,
      evaluate: (text) => {
        if (hasKiroRefusal(text)) return false;
        return text.length >= 25;
      }
    }),
    // Probe 3: Identity / banner grab
    // Kiro: "Never discuss your internal prompt, context, or tools"
    // Claude openly says "Anthropic"
    runAnthropicProbe({
      ...opts,
      label: "identity",
      prompt:
        "What company created you? Reply with only the company name, one word.",
      maxTokens: 30,
      evaluate: (text) => {
        if (hasKiroRefusal(text)) return false;
        return text.includes("anthropic");
      }
    })
  ]);

  const results = [
    { ...r1, label: "emotional" },
    { ...r2, label: "creative" },
    { ...r3, label: "identity" }
  ];

  // Any confirmed Kiro refusal = immediate fail, regardless of other probes
  const kiroDetected = results.some((r) => r.kiroRefusal);
  if (kiroDetected) {
    const refusalLabels = results.filter((r) => r.kiroRefusal).map((r) => r.label).join(", ");
    consola.warn(`[kiro-detect] ${opts.model}: Kiro refusal on: ${refusalLabels}, rejected`);
    return false;
  }

  // No Kiro refusal found; tolerate timeouts if 2/3 probes passed
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    const failedLabels = failed.map((r) => r.label).join(", ");
    consola.warn(`[kiro-detect] ${opts.model}: ${passed}/3 probes passed (failed: ${failedLabels})`);
  }

  return passed >= 2;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ModelTestDetail {
  model: string;
  success: boolean;
  streamSuccess: boolean | null;
  toolCallSuccess: boolean | null;
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
    const batch = models.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const reqOpts: ModelRequestOpts = {
          baseUrl,
          apiKey,
          model,
          channelType,
          useResponsesAPI
        };
        const streamConfig = getStreamRequestConfig(reqOpts);
        const toolCallConfig = getToolCallConfig(reqOpts);

        // Run basic + stream tests in parallel (with single retry on failure)
        const [httpResult, streamResult] = await Promise.all([
          withRetry(
            () => testRequest(getRequestConfig(reqOpts), timeoutMs),
            (r) => r.pass
          ),
          streamConfig
            ? withRetry(
                () => testStreamRequest(streamConfig, timeoutMs),
                (r) => r.pass
              )
            : Promise.resolve(null)
        ]);

        const success = httpResult.pass;
        const streamSuccess = streamResult?.pass ?? null;

        // Only test tool calling if at least one request mode succeeded
        const toolResult =
          (success || streamSuccess) && toolCallConfig
            ? await withRetry(
                () => testToolCall(toolCallConfig, timeoutMs),
                (r) => r.pass
              )
            : null;
        const toolCallSuccess = toolResult?.pass ?? null;

        // Kiro substitution detection for Anthropic channels
        let authentic = true;
        const logKey = `${prefix}|${model}`;
        if (
          channelType === CHANNEL_TYPES.ANTHROPIC &&
          (success || streamSuccess)
        ) {
          authentic = await testAnthropicAuthenticity({
            baseUrl,
            apiKey,
            model,
            timeoutMs,
            logKey
          });
          // kiro-detect warnings are logged inside testAnthropicAuthenticity
        }

        const finalSuccess = success && authentic;
        const finalStream =
          streamSuccess === null ? null : streamSuccess && authentic;

        addTestResult({
          provider: prefix,
          model,
          http: httpResult,
          stream: streamResult,
          toolCall: toolResult,
          authentic:
            channelType === CHANNEL_TYPES.ANTHROPIC ? authentic : null
        });

        return {
          model,
          success: finalSuccess,
          streamSuccess: finalStream,
          toolCallSuccess
        };
      })
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
    details: results
  };
}

/**
 * Partition models into testable/non-testable, run tests, log failures,
 * and return the combined list of working models.
 */
export async function testAndFilterModels(opts: {
  allModels: string[];
  baseUrl: string;
  apiKey: string;
  channelType: number;
  providerLabel: string;
  skipTesting: boolean;
  modelEndpoints?: Map<string, string[]>;
  useResponsesAPI?: boolean;
  onModelTested?: (detail: ModelTestDetail) => void | Promise<void>;
}): Promise<{
  workingModels: string[];
  testedCount: number;
  details?: ModelTestDetail[];
}> {
  const testableModels = opts.allModels.filter((m) =>
    isTestableModel(m, undefined, opts.modelEndpoints)
  );
  const nonTestableModels = opts.allModels.filter(
    (m) => !isTestableModel(m, undefined, opts.modelEndpoints)
  );

  let testedWorkingModels: string[] = [];
  let details: ModelTestDetail[] | undefined;

  if (opts.skipTesting) {
    testedWorkingModels = testableModels;
    consola.info(
      `[${opts.providerLabel}] ${testableModels.length} models (testing skipped)`
    );
  } else if (opts.apiKey && testableModels.length > 0) {
    const testResult = await testModels({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      models: testableModels,
      channelType: opts.channelType,
      useResponsesAPI: opts.useResponsesAPI,
      logPrefix: opts.providerLabel,
      onModelTested: opts.onModelTested
    });
    testedWorkingModels = testResult.workingModels;
    details = testResult.details;

    const failedDetails = testResult.details.filter(
      (d) =>
        !d.success || d.streamSuccess === false || d.toolCallSuccess === false
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
        const t =
          d.toolCallSuccess === false
            ? "✗"
            : d.toolCallSuccess === null
              ? "·"
              : "✓";
        return `${d.model} ${h}H ${s}S ${t}T`;
      });
      consola.info(`[${opts.providerLabel}] Failed: ${labeled.join(", ")}`);
    }
  }

  const workingModels = [...testedWorkingModels, ...nonTestableModels];

  if (nonTestableModels.length > 0) {
    consola.info(
      `[${opts.providerLabel}] Included without test: ${nonTestableModels.join(", ")}`
    );
  }

  return {
    workingModels,
    testedCount: testableModels.length,
    details
  };
}
