import { CHANNEL_TYPES, isTestableModel, TIMEOUTS } from "@/lib/constants";
import { tryFetchJson } from "@/lib/http";
import { consola } from "consola";

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
  /** The marker that signals the stream completed successfully */
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
  // Trivially simple prompt that requires no reasoning, keeping thinking tokens minimal
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
        messages: [
          {
            role: "user",
            content: "What model are you? One sentence is enough"
          }
        ],
        max_tokens: 50
      },
      isSuccess: (data) => {
        const d = data as {
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
        if (d.type === "error") return false;
        // Extract all text from content blocks (handles both regular and thinking models)
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
    // Gemini uses a different streaming mechanism (streamGenerateContent)
    // with finishReason in the last chunk rather than SSE markers.
    // Skip streaming test for Gemini as it requires special handling.
    return null;
  }
  if (useResponsesAPI) {
    // Responses API streaming uses a different event format; skip for now
    return null;
  }
  // OpenAI-compatible format (OpenAI, DeepSeek, Kimi, GLM, Grok, Qwen, etc.)
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

// Minimal tool definition reused across all channel types
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

/**
 * Build a tool-calling test request config for the given channel type.
 * Returns null for channel types where tool testing is not applicable
 * (e.g. Responses API, thinking/reasoning models that don't support forced tool choice).
 */
function getToolCallConfig(
  opts: ModelRequestOpts
): ToolCallRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;

  if (useResponsesAPI) return null;

  // Thinking/reasoning models don't support forced tool_choice
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

  // OpenAI-compatible format
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

/** Retry a test once on failure to avoid transient errors poisoning capabilities. */
async function withRetry(fn: () => Promise<boolean>): Promise<boolean> {
  const result = await fn();
  if (result) return true;
  return fn();
}

async function testRequest(
  config: RequestConfig,
  timeoutMs: number
): Promise<boolean> {
  const data = await tryFetchJson<unknown>(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    timeoutMs
  });
  return data !== null && config.isSuccess(data);
}

/**
 * Test that a model's streaming response terminates correctly.
 * Reads the SSE stream and checks for the expected completion marker.
 */
async function testStreamRequest(
  config: StreamRequestConfig,
  timeoutMs: number
): Promise<boolean> {
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(config.body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok || !response.body) return false;

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
        // Cancel the rest of the stream, we found what we need
        reader.cancel();
        break;
      }

      // Check for error response (non-SSE JSON error)
      if (buffer.startsWith("{") && buffer.includes('"error"')) {
        reader.cancel();
        return false;
      }
    }

    return foundMarker;
  } catch {
    return false;
  }
}

/**
 * Test that a model supports tool/function calling by sending a request
 * with tools and tool_choice forcing a tool call, then validating the
 * response actually contains a tool call.
 */
async function testToolCall(
  config: ToolCallRequestConfig,
  timeoutMs: number
): Promise<boolean> {
  const data = await tryFetchJson<unknown>(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    timeoutMs
  });
  return data !== null && config.isToolCallSuccess(data);
}

export interface ModelTestDetail {
  model: string;
  success: boolean;
  /** Whether streaming test passed. null if streaming was not tested. */
  streamSuccess: boolean | null;
  /** Whether tool calling test passed. null if not tested. */
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
        const [success, streamSuccess] = await Promise.all([
          withRetry(() => testRequest(getRequestConfig(reqOpts), timeoutMs)),
          streamConfig
            ? withRetry(() => testStreamRequest(streamConfig, timeoutMs))
            : Promise.resolve(null as boolean | null)
        ]);

        // Only test tool calling if at least one request mode succeeded
        const toolCallSuccess =
          (success || streamSuccess) && toolCallConfig
            ? await withRetry(() => testToolCall(toolCallConfig, timeoutMs))
            : (null as boolean | null);

        return { model, success, streamSuccess, toolCallSuccess };
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
    // A model is "working" if at least one request mode succeeded (HTTP or streaming).
    // Capability details (streaming, tool_calling) are stored on the channel
    // so the router can make smart decisions per request.
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
