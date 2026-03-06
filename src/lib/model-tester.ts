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

interface ModelRequestOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  channelType: number;
  useResponsesAPI: boolean;
}

function getRequestConfig(opts: ModelRequestOpts): RequestConfig {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
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
        messages: [{ role: "user", content: "1" }],
        max_tokens: 1,
      },
      isSuccess: (data) => (data as { type?: string }).type !== "error",
    };
  }
  if (channelType === CHANNEL_TYPES.GEMINI) {
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { "Content-Type": "application/json" },
      body: {
        contents: [{ parts: [{ text: "1" }] }],
        generationConfig: { maxOutputTokens: 1 },
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
        input: [{ role: "user", content: [{ type: "input_text", text: "1" }] }],
        max_output_tokens: 1,
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
      messages: [{ role: "user", content: "1" }],
      max_tokens: 1,
    },
    isSuccess: (data) => !(data as { error?: unknown }).error,
  };
}

function getStreamRequestConfig(
  opts: ModelRequestOpts,
): StreamRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
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
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
        stream: true,
      },
      completionMarker: "message_stop",
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
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
      stream: true,
    },
    completionMarker: "data: [DONE]",
  };
}

async function testRequest(
  config: RequestConfig,
  timeoutMs: number,
): Promise<boolean> {
  const data = await tryFetchJson<unknown>(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    timeoutMs,
  });
  return data !== null && config.isSuccess(data);
}

/**
 * Test that a model's streaming response terminates correctly.
 * Reads the SSE stream and checks for the expected completion marker.
 */
async function testStreamRequest(
  config: StreamRequestConfig,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(config.body),
      signal: AbortSignal.timeout(timeoutMs),
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

export interface ModelTestDetail {
  model: string;
  success: boolean;
  /** Whether streaming test passed. null if streaming was not tested. */
  streamSuccess: boolean | null;
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
          useResponsesAPI,
        };
        const streamConfig = getStreamRequestConfig(reqOpts);

        // Run both tests in parallel
        const [success, streamSuccess] = await Promise.all([
          testRequest(getRequestConfig(reqOpts), timeoutMs),
          streamConfig
            ? testStreamRequest(streamConfig, timeoutMs)
            : Promise.resolve(null as boolean | null),
        ]);

        return { model, success, streamSuccess };
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
      .filter((r) => r.success && r.streamSuccess !== false)
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
    isTestableModel(m, undefined, opts.modelEndpoints),
  );
  const nonTestableModels = opts.allModels.filter(
    (m) => !isTestableModel(m, undefined, opts.modelEndpoints),
  );

  let testedWorkingModels: string[] = [];
  let details: ModelTestDetail[] | undefined;

  if (opts.skipTesting) {
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
      onModelTested: opts.onModelTested,
    });
    testedWorkingModels = testResult.workingModels;
    details = testResult.details;

    const failedDetails = testResult.details.filter(
      (d) => !d.success || d.streamSuccess === false,
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
        return `${d.model} ${h}H ${s}S`;
      });
      consola.info(`[${opts.providerLabel}] Failed: ${labeled.join(", ")}`);
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
