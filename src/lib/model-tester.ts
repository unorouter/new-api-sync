import { CHANNEL_TYPES, TIMEOUTS } from "@/lib/constants";
import { tryFetchJson } from "@/lib/http";

interface RequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  isSuccess: (data: unknown) => boolean;
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
        messages: [{ role: "user", content: "hi" }],
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
        contents: [{ parts: [{ text: "hi" }] }],
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
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
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
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    },
    isSuccess: (data) => !(data as { error?: unknown }).error,
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

export async function testModels(
  baseUrl: string,
  apiKey: string,
  models: string[],
  channelType: number,
  useResponsesAPI = false,
  concurrency = 5,
  timeoutMs: number = TIMEOUTS.MODEL_TEST_MS,
): Promise<{
  workingModels: string[];
  details: Array<{ model: string; success: boolean }>;
}> {
  const results: Array<{ model: string; success: boolean }> = [];

  for (let i = 0; i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const success = await testRequest(
          getRequestConfig(
            baseUrl,
            apiKey,
            model,
            channelType,
            useResponsesAPI,
          ),
          timeoutMs,
        );
        return { model, success };
      }),
    );
    results.push(...batchResults);
  }

  return {
    workingModels: results.filter((r) => r.success).map((r) => r.model),
    details: results,
  };
}
