import type { ModelType } from "@core/types";

export const ENDPOINT_DEFAULT_PATHS: Record<string, string> = {
  openai: "/v1/chat/completions",
  "openai-response": "/v1/responses",
  "openai-response-compact": "/v1/responses/compact",
  anthropic: "/v1/messages",
  gemini: "/v1beta/models/{model}:generateContent",
  "jina-rerank": "/v1/rerank",
  "image-generation": "/v1/images/generations",
  embedding: "/v1/embeddings",
  "openai-video": "/v1/videos",
};

export const MODEL_TYPE_CANONICAL_ENDPOINT: Partial<Record<ModelType, string>> =
  {
    image: "image-generation",
    video: "openai-video",
  };

// prettier-ignore
export const TEXT_ENDPOINT_TYPES = new Set(["openai","anthropic","gemini","openai-response","openai-response-compact"]);

export const ENDPOINT_TO_MODEL_TYPE: Record<string, ModelType> = {
  "image-generation": "image",
  "dall-e-3": "image",
  "aigc-image": "image",
  "openai-video": "video",
  "aigc-video": "video",
  embeddings: "embedding",
  embedding: "embedding",
  rerank: "embedding",
  "jina-rerank": "embedding",
  geminitts: "audio",
};

// prettier-ignore
export const ENDPOINT_KEYWORD_TYPES: [string, ModelType][] = [["视频","video"],["video","video"],["动作","video"],["角色","video"],["首尾帧","video"],["生图","image"],["扩图","image"],["修图","image"],["image","image"],["edit","image"],["音","audio"],["tts","audio"],["嵌入","embedding"]];

// prettier-ignore
export const NON_TESTABLE_ENDPOINT_TYPES = new Set(["image-generation","dall-e-3","embeddings","openai-video","jina-rerank"]);

export function normalizeEndpointType(ep: string): string {
  if (ep in ENDPOINT_DEFAULT_PATHS) return ep;
  const exact = ENDPOINT_TO_MODEL_TYPE[ep];
  if (exact) return ep;
  const lower = ep.toLowerCase();
  for (const [keyword, type] of ENDPOINT_KEYWORD_TYPES) {
    if (lower.includes(keyword)) {
      return MODEL_TYPE_CANONICAL_ENDPOINT[type] ?? ep;
    }
  }
  return ep;
}

export function normalizeEndpointTypes(eps: string[]): string[] {
  return [...new Set(eps.map(normalizeEndpointType))];
}
