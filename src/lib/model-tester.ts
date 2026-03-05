import { CHANNEL_TYPES, TIMEOUTS } from "@/lib/constants";
import { tryFetchJson } from "@/lib/http";

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

function getRequestConfig(
  baseUrl: string,
  apiKey: string,
  model: string,
  channelType: number,
  useResponsesAPI: boolean,
): RequestConfig {
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
        input: [
          { role: "user", content: [{ type: "input_text", text: "1" }] },
        ],
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
  baseUrl: string,
  apiKey: string,
  model: string,
  channelType: number,
  useResponsesAPI: boolean,
): StreamRequestConfig | null {
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
      completionMarker: "event: message_stop",
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

export async function testModels(
  baseUrl: string,
  apiKey: string,
  models: string[],
  channelType: number,
  useResponsesAPI = false,
  concurrency = 5,
  timeoutMs: number = TIMEOUTS.MODEL_TEST_MS,
  onModelTested?: (detail: ModelTestDetail) => void | Promise<void>,
): Promise<{
  workingModels: string[];
  details: ModelTestDetail[];
}> {
  const results: ModelTestDetail[] = [];

  for (let i = 0; i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const streamConfig = getStreamRequestConfig(
          baseUrl,
          apiKey,
          model,
          channelType,
          useResponsesAPI,
        );

        // Run both tests in parallel
        const [success, streamSuccess] = await Promise.all([
          testRequest(
            getRequestConfig(baseUrl, apiKey, model, channelType, useResponsesAPI),
            timeoutMs,
          ),
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
