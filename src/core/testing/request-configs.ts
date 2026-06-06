import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import type {
  AnthropicResponse,
  ErrorEnvelope,
  GeminiResponse,
  ModelRequestOpts,
  OpenAIChatResponse,
  OpenAIDataResponse,
  RequestConfig,
  StreamRequestConfig,
  ToolCallRequestConfig,
} from "./types";

const TEST_PROMPT = "Reply with only the word ok.";
const noError = (data: unknown) => !(data as ErrorEnvelope).error;
const jsonBearer = (apiKey: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiKey}`,
});
const jsonAnthropic = (apiKey: string) => ({
  "Content-Type": "application/json",
  "x-api-key": apiKey,
  "anthropic-version": "2023-06-01",
});
const jsonOnly = { "Content-Type": "application/json" };
const userMsg = (content: string) => [{ role: "user", content }];

export function getRequestConfig(opts: ModelRequestOpts): RequestConfig {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
  if (channelType === CHANNEL_TYPES.ANTHROPIC)
    return {
      url: `${baseUrl}/v1/messages`,
      headers: jsonAnthropic(apiKey),
      body: { model, messages: userMsg(TEST_PROMPT), max_tokens: 50 },
      isSuccess: (data) => {
        const d = data as AnthropicResponse;
        if (d.type === "error") return false;
        const fullText = (d.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(" ")
          .toLowerCase();
        return !fullText.includes("kiro");
      },
    };
  if (channelType === CHANNEL_TYPES.GEMINI)
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: jsonOnly,
      body: {
        contents: [{ parts: [{ text: TEST_PROMPT }] }],
        generationConfig: { maxOutputTokens: 3 },
      },
      isSuccess: noError,
    };
  if (useResponsesAPI)
    return {
      url: `${baseUrl}/v1/responses`,
      headers: jsonBearer(apiKey),
      body: {
        model,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: TEST_PROMPT }],
          },
        ],
        max_output_tokens: 3,
        store: false,
      },
      isSuccess: noError,
    };
  // Zhipu v4 (Z.ai) is OpenAI-format but served at /v4/chat/completions (no /v1).
  // Reasoning flash models can spend the whole budget on thinking and return empty
  // content, so judge on error-presence only (max_tokens kept generous).
  if (channelType === CHANNEL_TYPES.ZHIPU_V4)
    return {
      url: `${baseUrl}/chat/completions`,
      headers: jsonBearer(apiKey),
      body: { model, messages: userMsg(TEST_PROMPT), max_tokens: 64 },
      isSuccess: noError,
    };
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: jsonBearer(apiKey),
    body: { model, messages: userMsg(TEST_PROMPT), max_tokens: 3 },
    isSuccess: noError,
  };
}

export function getStreamRequestConfig(
  opts: ModelRequestOpts,
): StreamRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
  if (channelType === CHANNEL_TYPES.ANTHROPIC)
    return {
      url: `${baseUrl}/v1/messages`,
      headers: jsonAnthropic(apiKey),
      body: {
        model,
        messages: userMsg(TEST_PROMPT),
        max_tokens: 5,
        stream: true,
      },
      completionMarker: "message_stop",
    };
  if (channelType === CHANNEL_TYPES.GEMINI || useResponsesAPI) return null;
  const chatUrl =
    channelType === CHANNEL_TYPES.ZHIPU_V4
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;
  return {
    url: chatUrl,
    headers: jsonBearer(apiKey),
    body: {
      model,
      messages: userMsg(TEST_PROMPT),
      max_tokens: channelType === CHANNEL_TYPES.ZHIPU_V4 ? 64 : 5,
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
  meta?: { supportsTools?: boolean; isReasoning?: boolean },
): ToolCallRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
  if (
    useResponsesAPI ||
    meta?.supportsTools === false ||
    meta?.isReasoning === true
  )
    return null;
  if (model.endsWith("-thinking") || model.includes("-thinking-")) return null;

  if (channelType === CHANNEL_TYPES.ANTHROPIC)
    return {
      url: `${baseUrl}/v1/messages`,
      headers: jsonAnthropic(apiKey),
      body: {
        model,
        messages: userMsg(TOOL_PROMPT),
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
        const d = data as AnthropicResponse;
        if (d.stop_reason === "tool_use") return true;
        return (
          Array.isArray(d.content) &&
          d.content.some((c) => c.type === "tool_use")
        );
      },
    };
  if (channelType === CHANNEL_TYPES.GEMINI)
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: jsonOnly,
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
        const d = data as GeminiResponse;
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
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: jsonBearer(apiKey),
    body: {
      model,
      messages: userMsg(TOOL_PROMPT),
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
      const d = data as OpenAIChatResponse;
      const choice = d.choices?.[0];
      if (!choice) return false;
      if (choice.finish_reason === "tool_calls") return true;
      return (choice.message?.tool_calls?.length ?? 0) > 0;
    },
  };
}

const bearerBody = (
  opts: ModelRequestOpts,
  url: string,
  body: object,
  isSuccess: (d: unknown) => boolean = noError,
): RequestConfig => ({
  url: `${opts.baseUrl}${url}`,
  headers: jsonBearer(opts.apiKey),
  body,
  isSuccess,
});

export const getImageTestConfig = (opts: ModelRequestOpts): RequestConfig =>
  bearerBody(opts, "/v1/images/generations", {
    model: opts.model,
    prompt: "a tiny red circle",
    n: 1,
    size: "256x256",
  });

export const getVideoTestConfig = (opts: ModelRequestOpts): RequestConfig =>
  bearerBody(opts, "/v1/videos", {
    model: opts.model,
    prompt: "a slow pan over a landscape",
  });

export const getEmbeddingTestConfig = (opts: ModelRequestOpts): RequestConfig =>
  bearerBody(
    opts,
    "/v1/embeddings",
    { model: opts.model, input: "test" },
    (data) => {
      const d = data as OpenAIDataResponse;
      return !d.error && Array.isArray(d.data);
    },
  );

export const getAudioTestConfig = (opts: ModelRequestOpts): RequestConfig =>
  bearerBody(opts, "/v1/audio/speech", {
    model: opts.model,
    input: "test",
    voice: "alloy",
  });
