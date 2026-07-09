import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { configDir } from "@core/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  ToolProbeVerdict,
} from "./types";

const TEST_PROMPT = "Reply with only the word ok.";

// OpenAI gpt-5* and o1/o3/o4 reasoning models reject `max_tokens` (require
// `max_completion_tokens`). new-api's OpenAI adaptor translates this for user traffic, but
// the sync probe hits the upstream directly, so build the correct field here by bare name.
const bareModel = (model: string) => {
  const slash = model.lastIndexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1)).toLowerCase();
};
const needsMaxCompletionTokens = (model: string) => {
  const n = bareModel(model);
  return (
    n.startsWith("gpt-5") ||
    n.startsWith("o1") ||
    n.startsWith("o3") ||
    n.startsWith("o4")
  );
};
const tokenBudget = (model: string, n: number) =>
  needsMaxCompletionTokens(model)
    ? { max_completion_tokens: n }
    : { max_tokens: n };
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
  // Zhipu v4 (Z.ai): OpenAI-format body at /api/paas/v4/chat/completions (baseUrl is
  // the host, matching new-api's ZHIPU_V4 adapter). Reasoning flash models can spend
  // the whole budget on thinking and return empty content, so judge on error-presence
  // only (max_tokens kept generous).
  if (channelType === CHANNEL_TYPES.ZHIPU_V4)
    return {
      url: `${baseUrl}/api/paas/v4/chat/completions`,
      headers: jsonBearer(apiKey),
      body: { model, messages: userMsg(TEST_PROMPT), max_tokens: 64 },
      isSuccess: noError,
    };
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: jsonBearer(apiKey),
    // 16 is the floor some backends accept (AI Horde rejects max_tokens < 16);
    // still tiny for a liveness probe.
    body: { model, messages: userMsg(TEST_PROMPT), ...tokenBudget(model, 16) },
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
      ? `${baseUrl}/api/paas/v4/chat/completions`
      : `${baseUrl}/v1/chat/completions`;
  return {
    url: chatUrl,
    headers: jsonBearer(apiKey),
    body: {
      model,
      messages: userMsg(TEST_PROMPT),
      ...tokenBudget(model, channelType === CHANNEL_TYPES.ZHIPU_V4 ? 64 : 16),
      stream: true,
    },
    completionMarker: "data: [DONE]",
  };
}

// Universal harness-grade tool probe: ONE request exercises every failure mode a coding
// harness (Cline/Roo/Kilo/Claude Code) hits. History contains a COMPLETED tool exchange
// (round-trip acceptance), 5 schemas force tool SELECTION, the prompt demands weather for
// TWO cities (parallel calls), OpenAI-compat runs stream:true so tool_call deltas must
// reassemble. No tool_choice: harnesses don't send it; the model must choose from prompt.
const probeTool = (
  name: string,
  description: string,
  properties: object,
  required: string[],
) => ({
  name,
  description,
  parameters: { type: "object", properties, required },
});
// prettier-ignore
const PROBE_TOOLS = [
  probeTool("calculator", "Calculate a math expression", { expression: { type: "string" } }, ["expression"]),
  probeTool("get_weather", "Get current weather for a city", { city: { type: "string", description: "City name" }, units: { type: "string", enum: ["celsius", "fahrenheit"] } }, ["city"]),
  probeTool("read_file", "Read a file from the workspace", { path: { type: "string" }, range: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" } } } }, ["path"]),
  probeTool("search_web", "Search the web", { query: { type: "string" }, max_results: { type: "integer" } }, ["query"]),
  probeTool("list_files", "List files in a directory", { path: { type: "string" }, recursive: { type: "boolean" } }, ["path"]),
];
const PROBE_CALC_PROMPT =
  "What is 2+2? You must use the calculator tool to answer.";
const PROBE_WEATHER_PROMPT =
  "Thanks. Now fetch the current weather for Paris and for London using the weather tool. Call it once per city, both in this turn if you can.";
// 2048 so reasoning models survive the thinking pass and still reach the call.
const PROBE_MAX_TOKENS = 2048;

const hasCity = (args: unknown): boolean =>
  typeof (args as { city?: unknown } | null)?.city === "string";

const gradeOpenAIToolCall = (data: unknown): ToolProbeVerdict => {
  const d = data as OpenAIChatResponse;
  const choice = d.choices?.[0];
  const weather = (choice?.message?.tool_calls ?? []).filter((c) => {
    if (c.function?.name !== "get_weather") return false;
    try {
      return hasCity(JSON.parse(c.function.arguments || "{}"));
    } catch {
      return false;
    }
  });
  return {
    pass: weather.length >= 1 && choice?.finish_reason === "tool_calls",
    parallel: weather.length >= 2,
  };
};

export function getToolCallConfig(
  opts: ModelRequestOpts,
  meta?: { supportsTools?: boolean; isReasoning?: boolean },
): ToolCallRequestConfig | null {
  const { baseUrl, apiKey, model, channelType, useResponsesAPI } = opts;
  if (useResponsesAPI || meta?.supportsTools === false) return null;

  if (channelType === CHANNEL_TYPES.ANTHROPIC)
    return {
      url: `${baseUrl}/v1/messages`,
      headers: jsonAnthropic(apiKey),
      body: {
        model,
        max_tokens: PROBE_MAX_TOKENS,
        tools: PROBE_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        messages: [
          { role: "user", content: PROBE_CALC_PROMPT },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_probe_1",
                name: "calculator",
                input: { expression: "2+2" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_probe_1",
                content: "4",
              },
              { type: "text", text: PROBE_WEATHER_PROMPT },
            ],
          },
        ],
      },
      gradeToolCall: (data) => {
        const d = data as AnthropicResponse;
        const weather = (d.content ?? []).filter(
          (b) =>
            b.type === "tool_use" &&
            b.name === "get_weather" &&
            hasCity(b.input),
        );
        return {
          pass: weather.length >= 1 && d.stop_reason === "tool_use",
          parallel: weather.length >= 2,
        };
      },
    };
  if (channelType === CHANNEL_TYPES.GEMINI)
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: jsonOnly,
      body: {
        contents: [
          { role: "user", parts: [{ text: PROBE_CALC_PROMPT }] },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "calculator",
                  args: { expression: "2+2" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "calculator",
                  response: { result: "4" },
                },
              },
              { text: PROBE_WEATHER_PROMPT },
            ],
          },
        ],
        tools: [{ functionDeclarations: PROBE_TOOLS }],
        generationConfig: { maxOutputTokens: PROBE_MAX_TOKENS },
      },
      gradeToolCall: (data) => {
        const d = data as GeminiResponse;
        const weather = (d.candidates?.[0]?.content?.parts ?? []).filter(
          (p) =>
            p.functionCall?.name === "get_weather" &&
            hasCity(p.functionCall.args),
        );
        return { pass: weather.length >= 1, parallel: weather.length >= 2 };
      },
    };
  const chatUrl =
    channelType === CHANNEL_TYPES.ZHIPU_V4
      ? `${baseUrl}/api/paas/v4/chat/completions`
      : `${baseUrl}/v1/chat/completions`;
  return {
    url: chatUrl,
    headers: jsonBearer(apiKey),
    stream: true,
    body: {
      model,
      stream: true,
      ...tokenBudget(model, PROBE_MAX_TOKENS),
      tools: PROBE_TOOLS.map((t) => ({ type: "function", function: t })),
      messages: [
        { role: "user", content: PROBE_CALC_PROMPT },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_probe_1",
              type: "function",
              function: {
                name: "calculator",
                arguments: '{"expression":"2+2"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_probe_1", content: "4" },
        { role: "user", content: PROBE_WEATHER_PROMPT },
      ],
    },
    gradeToolCall: gradeOpenAIToolCall,
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

export const getImageTestConfig = (opts: ModelRequestOpts): RequestConfig => {
  // Cloudflare Workers AI: native /ai/run/{model}, base64 in result.image.
  if (opts.channelType === CHANNEL_TYPES.CLOUDFLARE)
    return {
      url: `${opts.baseUrl}/run/${opts.model}`,
      headers: jsonBearer(opts.apiKey),
      body: { prompt: "a tiny red circle" },
      isSuccess: (data) => {
        const d = data as {
          success?: boolean;
          result?: { image?: string };
          __binaryMedia?: boolean;
        };
        // Either a JSON {result.image} (flux-schnell) or a raw PNG/JPEG body.
        return (
          d.__binaryMedia === true ||
          d.success === true ||
          typeof d.result?.image === "string"
        );
      },
    };
  return bearerBody(opts, "/v1/images/generations", {
    model: opts.model,
    prompt: "a tiny red circle",
    n: 1,
    // 1024x1024 is the universally-accepted SDXL size; OVH rejects anything else.
    size: "1024x1024",
  });
};

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

// Speech-to-text models are recognized by name; everything else audio is TTS.
const isSttModel = (model: string) =>
  /whisper|transcrib|asr|speech-to-text|stt|nova-|\bflux\b/i.test(model);

let cachedProbeWav: ArrayBuffer | null = null;
function probeWavBytes(): ArrayBuffer {
  if (!cachedProbeWav) {
    const buf = readFileSync(join(configDir(), "audio", "probe.wav"));
    cachedProbeWav = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  }
  return cachedProbeWav;
}
function probeWavForm(model: string): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([probeWavBytes()], { type: "audio/wav" }),
    "probe.wav",
  );
  form.append("model", model);
  return form;
}

export const getAudioTestConfig = (opts: ModelRequestOpts): RequestConfig => {
  // Cloudflare: native /ai/run/{model}. STT takes raw audio bytes; TTS takes JSON.
  if (opts.channelType === CHANNEL_TYPES.CLOUDFLARE) {
    if (isSttModel(opts.model))
      return {
        url: `${opts.baseUrl}/run/${opts.model}`,
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: probeWavBytes(),
        isSuccess: (data) => {
          const d = data as {
            success?: boolean;
            __binaryMedia?: boolean;
            result?: unknown;
          };
          return d.success === true || d.result !== undefined;
        },
      };
    return {
      url: `${opts.baseUrl}/run/${opts.model}`,
      headers: jsonBearer(opts.apiKey),
      body: { prompt: "hello world", lang: "en" },
      isSuccess: (data) => {
        const d = data as { success?: boolean; __binaryMedia?: boolean };
        return d.__binaryMedia === true || d.success === true;
      },
    };
  }
  // OpenAI-compatible (groq): STT = multipart /audio/transcriptions, TTS = /audio/speech.
  if (isSttModel(opts.model))
    return {
      url: `${opts.baseUrl}/v1/audio/transcriptions`,
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: probeWavForm(opts.model),
      isSuccess: (data) => typeof (data as { text?: string }).text === "string",
    };
  return bearerBody(opts, "/v1/audio/speech", {
    model: opts.model,
    input: "test",
    voice: "alloy",
  });
};
