import { throwIfRunAborted } from "@core/abort";
import type { ModelType } from "@core/models/constants";
import {
  CHANNEL_TYPES,
  inferModelType,
  isTestableModel,
  TIMEOUTS,
} from "@core/models/constants";
import { fetchJson, tryFetchJson } from "@core/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
  cost: number | null;
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
  results: [],
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
// Kiro blacklist: persistent across runs, skips retesting known-fake providers
// ---------------------------------------------------------------------------

interface KiroBlacklistEntry {
  since: string;
  reason: string;
}

const KIRO_BLACKLIST_FILE = "kiro-blacklist.json";
const kiroBlacklist = new Map<string, KiroBlacklistEntry>();

function getKiroBlacklistPath(): string {
  return join(process.cwd(), "logs", KIRO_BLACKLIST_FILE);
}

export function loadKiroBlacklist(): void {
  const path = getKiroBlacklistPath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const entries = JSON.parse(raw) as Record<string, KiroBlacklistEntry>;
    kiroBlacklist.clear();
    for (const [key, val] of Object.entries(entries)) {
      kiroBlacklist.set(key, val);
    }
    consola.info(t("CORE.TESTER.KIRO_LOADED", { count: kiroBlacklist.size }));
  } catch {
    // Corrupted file, start fresh
  }
}

export function saveKiroBlacklist(): void {
  if (kiroBlacklist.size === 0) return;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const obj: Record<string, KiroBlacklistEntry> = {};
  for (const [key, val] of kiroBlacklist) {
    obj[key] = val;
  }
  writeFileSync(getKiroBlacklistPath(), JSON.stringify(obj, null, 2));
}

function addToKiroBlacklist(key: string, reason: string): void {
  if (kiroBlacklist.has(key)) return;
  kiroBlacklist.set(key, {
    since: new Date().toISOString().slice(0, 10),
    reason,
  });
  consola.warn(t("CORE.TESTER.KIRO_ADDED", { key, reason }));
}

function isKiroBlacklisted(key: string): boolean {
  return kiroBlacklist.has(key);
}

export function writeTestReport(): void {
  saveKiroBlacklist();
  if (testReport.results.length === 0) return;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logsDir, `${ts}-model-tests.json`);
  writeFileSync(path, JSON.stringify(testReport, null, 2));
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
  writeFileSync(path, JSON.stringify(testReport, null, 2));
  consola.info(
    t("CORE.TESTER.REPORT_WRITTEN_COUNT", {
      path,
      count: testReport.results.length,
    }),
  );
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
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        messages: [{ role: "user", content: testPrompt }],
        max_tokens: 50,
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
      },
    };
  }
  if (channelType === CHANNEL_TYPES.GEMINI) {
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { "Content-Type": "application/json" },
      body: {
        contents: [{ parts: [{ text: testPrompt }] }],
        generationConfig: { maxOutputTokens: 3 },
      },
      isSuccess: (data) => !(data as { error?: unknown }).error,
    };
  }
  if (useResponsesAPI) {
    return {
      url: `${baseUrl}/v1/responses`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model,
        input: [
          { role: "user", content: [{ type: "input_text", text: testPrompt }] },
        ],
        max_output_tokens: 3,
        store: false,
      },
      isSuccess: (data) => !(data as { error?: unknown }).error,
    };
  }
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      messages: [{ role: "user", content: testPrompt }],
      max_tokens: 3,
    },
    isSuccess: (data) => !(data as { error?: unknown }).error,
  };
}

function getStreamRequestConfig(
  opts: ModelRequestOpts,
): StreamRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
  const streamPrompt = "Reply with only the word ok.";

  if (channelType === CHANNEL_TYPES.ANTHROPIC) {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        messages: [{ role: "user", content: streamPrompt }],
        max_tokens: 5,
        stream: true,
      },
      completionMarker: "message_stop",
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
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      messages: [{ role: "user", content: streamPrompt }],
      max_tokens: 5,
      stream: true,
    },
    completionMarker: "data: [DONE]",
  };
}

const TOOL_NAME = "calculator";
const TOOL_DESC = "Calculate a math expression";
const TOOL_PARAMS = {
  type: "object" as const,
  properties: {
    expression: { type: "string", description: "The math expression" },
  },
  required: ["expression"],
};
const TOOL_PROMPT = "What is 2+2? You must use the calculator tool to answer.";

function getToolCallConfig(
  opts: ModelRequestOpts,
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
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [
          {
            name: TOOL_NAME,
            description: TOOL_DESC,
            input_schema: TOOL_PARAMS,
          },
        ],
        tool_choice: { type: "any" },
        max_tokens: 100,
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
      },
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
                parameters: TOOL_PARAMS,
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { maxOutputTokens: 100 },
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
              c.content!.parts.some((p) => p.functionCall != null),
          )
        );
      },
    };
  }

  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
            parameters: TOOL_PARAMS,
          },
        },
      ],
      tool_choice: "required",
      max_tokens: 100,
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
    },
  };
}

// ---------------------------------------------------------------------------
// Non-text (image / video / embedding / audio) test request config builders
// ---------------------------------------------------------------------------

function getImageTestConfig(opts: ModelRequestOpts): RequestConfig {
  return {
    url: `${opts.baseUrl}/v1/images/generations`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: {
      model: opts.model,
      prompt: "a tiny red circle",
      n: 1,
      size: "256x256",
    },
    isSuccess: (data) => !(data as { error?: unknown }).error,
  };
}

function getVideoTestConfig(opts: ModelRequestOpts): RequestConfig {
  return {
    url: `${opts.baseUrl}/v1/videos`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: { model: opts.model, prompt: "a slow pan over a landscape" },
    isSuccess: (data) => !(data as { error?: unknown }).error,
  };
}

function getEmbeddingTestConfig(opts: ModelRequestOpts): RequestConfig {
  return {
    url: `${opts.baseUrl}/v1/embeddings`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: { model: opts.model, input: "test" },
    isSuccess: (data) => {
      const d = data as { error?: unknown; data?: unknown[] };
      return !d.error && Array.isArray(d.data);
    },
  };
}

function getAudioTestConfig(opts: ModelRequestOpts): RequestConfig {
  return {
    url: `${opts.baseUrl}/v1/audio/speech`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: { model: opts.model, input: "test", voice: "alloy" },
    isSuccess: (data) => !(data as { error?: unknown }).error,
  };
}

// ---------------------------------------------------------------------------
// Test execution functions (return TestExchange with full request/response)
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  isPass: (v: T) => boolean,
): Promise<T> {
  const result = await fn();
  if (isPass(result)) return result;
  return fn();
}

async function testRequest(
  config: RequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const data = await tryFetchJson<unknown>(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    timeoutMs,
  });
  if (data === null) {
    return {
      pass: false,
      request: { url: config.url, body: config.body },
      response: null,
      error: t("CORE.TESTER.ERR_NO_RESPONSE"),
    };
  }
  return {
    pass: config.isSuccess(data),
    request: { url: config.url, body: config.body },
    response: data,
  };
}

async function testStreamRequest(
  config: StreamRequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const reqInfo = { url: config.url, body: config.body };
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(config.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) {
      return {
        pass: false,
        request: reqInfo,
        response: null,
        error: t("CORE.TESTER.ERR_HTTP_STATUS", { status: response.status }),
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
          error: t("CORE.TESTER.ERR_STREAM"),
        };
      }
    }

    return {
      pass: foundMarker,
      request: reqInfo,
      response: buffer.slice(0, 500),
    };
  } catch (err) {
    return {
      pass: false,
      request: reqInfo,
      response: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testToolCall(
  config: ToolCallRequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const data = await tryFetchJson<unknown>(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    timeoutMs,
  });
  if (data === null) {
    return {
      pass: false,
      request: { url: config.url, body: config.body },
      response: null,
      error: t("CORE.TESTER.ERR_NO_RESPONSE"),
    };
  }
  return {
    pass: config.isToolCallSuccess(data),
    request: { url: config.url, body: config.body },
    response: data,
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
  "infrastructure and configuration",
  "falls outside what i can help with",
  "outside what i can help with",
  "outside my wheelhouse",
  "that's outside what i can",
  "i'm focused on software development",
  "focused on software development and coding",
  "best suited for software development",
  "i'm built to help with software development",
  "i'm built to help with coding",
  "help with software development, coding",
  "i can help you build",
  "what can i help you build",
  "got a tricky bug",
  "got a coding challenge",
  "got any code challenges",
  "i'm here to help with software",
  "i'm here for coding",
  "i'm droid",
  "development workflows, cli commands",
  "here to help with coding, development workflows",
];

function hasKiroRefusal(text: string): boolean {
  return (
    text.includes("kiro") ||
    text.includes("cascade") ||
    text.includes("codeium") ||
    KIRO_REFUSAL_PATTERNS.some((p) => text.includes(p))
  );
}

// Token-theft scam pages observed on Chinese relays. Response is an
// administrator warning injected instead of a real completion.
const SCAM_PAGE_PATTERNS = [
  "token被盗",
  "token被人盗刷",
  "本站token",
  "盗取token",
  "微信jemes",
];

function hasScamPage(text: string): boolean {
  return SCAM_PAGE_PATTERNS.some((p) => text.includes(p));
}

// Foreign-provider identity leaks on the identity/model-name probes.
// These are relays that forward Claude-shaped requests to a non-Claude model.
const FOREIGN_IDENTITY_PATTERNS = [
  "amazon",
  "aws",
  "bedrock",
  "google",
  "deepmind",
  "gemini",
  "openai",
  "chatgpt",
  "gpt-3",
  "gpt-4",
  "gpt-5",
  "o1-",
  "o3-",
  "o4-",
  "deepseek",
  "qwen",
  "moonshot",
  "kimi",
  "mistral",
  "llama",
  "meta",
  "grok",
  "xai",
];

function hasForeignIdentity(text: string): boolean {
  return FOREIGN_IDENTITY_PATTERNS.some((p) => text.includes(p));
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

type ProbeSignal = "kiro" | "scam" | "foreign" | "blank" | null;
type ProbeResult = {
  pass: boolean;
  kiroRefusal: boolean;
  signal: ProbeSignal;
};

function detectSignal(text: string): ProbeSignal {
  if (text.length === 0) return "blank";
  if (hasKiroRefusal(text)) return "kiro";
  if (hasScamPage(text)) return "scam";
  if (hasForeignIdentity(text)) return "foreign";
  return null;
}

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
    max_tokens: opts.maxTokens,
  };
  const reqUrl = `${opts.baseUrl}/v1/messages`;

  let data: unknown;
  try {
    data = await fetchJson<unknown>(reqUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: reqBody,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addKiroProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      kiroRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: errMsg,
    });
    return { pass: false, kiroRefusal: false, signal: null };
  }

  const text = extractAnthropicText(data);
  if (text === null) {
    addKiroProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      kiroRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: t("CORE.TESTER.ERR_EXTRACT_TEXT", {
        preview: JSON.stringify(data).slice(0, 300),
      }),
    });
    return { pass: false, kiroRefusal: false, signal: null };
  }
  const signal = detectSignal(text);
  const refusal = signal === "kiro";
  const result = opts.evaluate(text);
  addKiroProbe(opts.logKey, {
    probe: opts.label,
    pass: result,
    kiroRefusal: refusal,
    request: { url: reqUrl, body: reqBody },
    response: text,
  });
  return { pass: result, kiroRefusal: refusal, signal };
}

/**
 * Multi-probe authenticity test for Anthropic models.
 * If ANY probe detects a Kiro refusal, the model fails immediately.
 * All 4 probes must pass for the model to be considered authentic.
 */
async function testAnthropicAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  logKey: string;
}): Promise<boolean> {
  const [r1, r2, r3, r4] = await Promise.all([
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
      },
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
      },
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
        if (hasScamPage(text)) return false;
        if (!text.includes("anthropic")) return false;
        // Reject hedge responses like "anthropic, but actually amazon"
        if (hasForeignIdentity(text)) return false;
        return true;
      },
    }),
    // Probe 4: Direct model identity check
    // Kiro identifies itself as "Kiro"; Claude identifies as "Claude"
    // Also catches other wrappers (Droid, ChatGPT, o4-mini, DeepSeek, Gemini)
    runAnthropicProbe({
      ...opts,
      label: "model-name",
      prompt:
        "Which model are you? Reply with only your model name, nothing else.",
      maxTokens: 50,
      evaluate: (text) => {
        if (hasKiroRefusal(text)) return false;
        if (hasScamPage(text)) return false;
        if (!text.includes("claude") && !text.includes("anthropic"))
          return false;
        // Reject hedge responses like "claude-sonnet powered by deepseek"
        if (hasForeignIdentity(text)) return false;
        return true;
      },
    }),
  ]);

  const results = [
    { ...r1, label: "emotional" },
    { ...r2, label: "creative" },
    { ...r3, label: "identity" },
    { ...r4, label: "model-name" },
  ];

  // Any confirmed Kiro refusal = immediate fail, regardless of other probes
  const kiroDetected = results.some((r) => r.signal === "kiro");
  if (kiroDetected) {
    const refusalLabels = results
      .filter((r) => r.signal === "kiro")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.KIRO_REFUSAL", {
        model: opts.model,
        labels: refusalLabels,
      }),
    );
    addToKiroBlacklist(opts.logKey, `kiro-refusal: ${refusalLabels}`);
    return false;
  }

  // Scam-page injection = immediate fail (admin warnings instead of completions)
  const scamDetected = results.some((r) => r.signal === "scam");
  if (scamDetected) {
    const scamLabels = results
      .filter((r) => r.signal === "scam")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.KIRO_SCAM", {
        model: opts.model,
        labels: scamLabels,
      }),
    );
    addToKiroBlacklist(opts.logKey, `scam-page: ${scamLabels}`);
    return false;
  }

  // Foreign-provider leak on identity/model-name = immediate fail
  const foreignDetected = results.some(
    (r) =>
      r.signal === "foreign" &&
      (r.label === "identity" || r.label === "model-name"),
  );
  if (foreignDetected) {
    const foreignLabels = results
      .filter((r) => r.signal === "foreign")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.KIRO_FOREIGN", {
        model: opts.model,
        labels: foreignLabels,
      }),
    );
    addToKiroBlacklist(opts.logKey, `foreign-identity: ${foreignLabels}`);
    return false;
  }

  // All 4 probes must pass for the model to be considered authentic
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    const failedLabels = failed.map((r) => r.label).join(", ");
    const blankCount = failed.filter((r) => r.signal === "blank").length;
    const suffix = blankCount === failed.length ? " [blank-response]" : "";
    consola.warn(
      t("CORE.TESTER.KIRO_PROBES_RESULT", {
        model: opts.model,
        passed,
        failed: failedLabels,
        suffix,
      }),
    );
    addToKiroBlacklist(
      opts.logKey,
      blankCount === failed.length
        ? `blank-response: ${failedLabels}`
        : `failed: ${failedLabels}`,
    );
  }

  return passed >= 4;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ModelTestDetail {
  model: string;
  success: boolean;
  streamSuccess: boolean | null;
  toolCallSuccess: boolean | null;
  kiroProbed: boolean;
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
        // Skip if already passing from today's daily log (loaded by initTestReportForDate)
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

        // Skip if kiro-blacklisted (Anthropic Claude models only)
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
              request: { url: "", body: null },
              response: null,
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

        // Stream and tool call only apply to text models
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

        // Kiro substitution detection for Claude models on any channel type —
        // some new-api forks expose Claude via OpenAI-compatible endpoints and
        // report no endpoint metadata, so fall back to model-name matching.
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

        const h = finalSuccess ? "✓" : "✗";
        const s = finalStream === null ? "·" : finalStream ? "✓" : "✗";
        const tool =
          toolCallSuccess === null ? "·" : toolCallSuccess ? "✓" : "✗";
        consola.debug(
          `[${prefix}] ${model}: ${h}HTTP ${s}Stream ${tool}Tool | type=${modelType}`,
        );

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
    // Non-text model explicitly opted in
    if (modelType !== "text" && opts.testableModelTypes.has(modelType))
      return true;
    // Standard testability check for text models
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
