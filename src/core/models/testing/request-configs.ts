import { CHANNEL_TYPES } from "@core/models/constants";
import type {
  ModelRequestOpts,
  RequestConfig,
  StreamRequestConfig,
  ToolCallRequestConfig,
} from "./types";

export function getRequestConfig(opts: ModelRequestOpts): RequestConfig {
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

export function getStreamRequestConfig(
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

export function getToolCallConfig(
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

export function getImageTestConfig(opts: ModelRequestOpts): RequestConfig {
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

export function getVideoTestConfig(opts: ModelRequestOpts): RequestConfig {
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

export function getEmbeddingTestConfig(opts: ModelRequestOpts): RequestConfig {
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

export function getAudioTestConfig(opts: ModelRequestOpts): RequestConfig {
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
