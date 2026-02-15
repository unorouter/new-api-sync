import micromatch from "micromatch";

// Pagination configuration
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 100,
  START_PAGE_ZERO: 0,
  START_PAGE_ONE: 1
} as const;

// Timeout configuration (milliseconds)
export const TIMEOUTS = {
  MODEL_TEST_MS: 10000
} as const;

// Retry configuration
export const RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 10000
} as const;

// Channel type identifiers from new-api (constant/channel.go)
export const CHANNEL_TYPES = {
  UNKNOWN: 0,
  OPENAI: 1,
  MIDJOURNEY: 2,
  AZURE: 3,
  OLLAMA: 4,
  MIDJOURNEY_PLUS: 5,
  OPENAI_MAX: 6,
  OH_MY_GPT: 7,
  CUSTOM: 8,
  AILS: 9,
  AI_PROXY: 10,
  PALM: 11,
  API2GPT: 12,
  AIGC2D: 13,
  ANTHROPIC: 14,
  BAIDU: 15,
  ZHIPU: 16,
  ALI: 17,
  XUNFEI: 18,
  AI360: 19,
  OPENROUTER: 20,
  AI_PROXY_LIBRARY: 21,
  FAST_GPT: 22,
  TENCENT: 23,
  GEMINI: 24,
  MOONSHOT: 25,
  ZHIPU_V4: 26,
  PERPLEXITY: 27,
  LINGYIWANWU: 31,
  AWS: 33,
  COHERE: 34,
  MINIMAX: 35,
  SUNO_API: 36,
  DIFY: 37,
  JINA: 38,
  CLOUDFLARE: 39,
  SILICONFLOW: 40,
  VERTEX_AI: 41,
  MISTRAL: 42,
  DEEPSEEK: 43,
  MOKA_AI: 44,
  VOLCENGINE: 45,
  BAIDU_V2: 46,
  XINFERENCE: 47,
  XAI: 48,
  COZE: 49,
  KLING: 50,
  JIMENG: 51,
  VIDU: 52,
  SUBMODEL: 53,
  DOUBAO_VIDEO: 54,
  SORA: 55,
  REPLICATE: 56,
  CODEX: 57
} as const;

// Vendor registry: maps vendor name to channel type, default base URL, and model discovery method
export interface VendorInfo {
  channelType: number;
  defaultBaseUrl: string;
  modelDiscovery: "openai" | "anthropic" | "gemini";
}

export const VENDOR_REGISTRY: Record<string, VendorInfo> = {
  openai: {
    channelType: CHANNEL_TYPES.OPENAI,
    defaultBaseUrl: "https://api.openai.com",
    modelDiscovery: "openai"
  },
  anthropic: {
    channelType: CHANNEL_TYPES.ANTHROPIC,
    defaultBaseUrl: "https://api.anthropic.com",
    modelDiscovery: "anthropic"
  },
  google: {
    channelType: CHANNEL_TYPES.GEMINI,
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    modelDiscovery: "gemini"
  },
  deepseek: {
    channelType: CHANNEL_TYPES.DEEPSEEK,
    defaultBaseUrl: "https://api.deepseek.com",
    modelDiscovery: "openai"
  },
  moonshot: {
    channelType: CHANNEL_TYPES.MOONSHOT,
    defaultBaseUrl: "https://api.moonshot.cn",
    modelDiscovery: "openai"
  },
  mistral: {
    channelType: CHANNEL_TYPES.MISTRAL,
    defaultBaseUrl: "https://api.mistral.ai",
    modelDiscovery: "openai"
  },
  xai: {
    channelType: CHANNEL_TYPES.XAI,
    defaultBaseUrl: "https://api.x.ai",
    modelDiscovery: "openai"
  },
  siliconflow: {
    channelType: CHANNEL_TYPES.SILICONFLOW,
    defaultBaseUrl: "https://api.siliconflow.cn",
    modelDiscovery: "openai"
  },
  cohere: {
    channelType: CHANNEL_TYPES.COHERE,
    defaultBaseUrl: "https://api.cohere.ai",
    modelDiscovery: "openai"
  },
  zhipu: {
    channelType: CHANNEL_TYPES.ZHIPU_V4,
    defaultBaseUrl: "https://open.bigmodel.cn",
    modelDiscovery: "openai"
  },
  volcengine: {
    channelType: CHANNEL_TYPES.VOLCENGINE,
    defaultBaseUrl: "https://ark.cn-beijing.volces.com",
    modelDiscovery: "openai"
  },
  minimax: {
    channelType: CHANNEL_TYPES.MINIMAX,
    defaultBaseUrl: "https://api.minimax.chat",
    modelDiscovery: "openai"
  },
  perplexity: {
    channelType: CHANNEL_TYPES.PERPLEXITY,
    defaultBaseUrl: "https://api.perplexity.ai",
    modelDiscovery: "openai"
  }
};

// Priority calculation constants
export const PRIORITY = {
  RESPONSE_TIME_DIVISOR: 10000,
  RESPONSE_TIME_OFFSET: 100
} as const;

// Text endpoint types from new-api (constant/endpoint_type.go)
// Non-text types: image-generation, embeddings, openai-video, jina-rerank
export const TEXT_ENDPOINT_TYPES = new Set([
  "openai",
  "anthropic",
  "gemini",
  "openai-response",
  "openai-response-compact"
]);

// Patterns that indicate non-text models (image, video, audio, embedding)
export const NON_TEXT_MODEL_PATTERNS = [
  // Image generation
  "dall-e",
  "dalle",
  "gpt-image",
  "imagen",
  "midjourney",
  "stable-diffusion",
  "flux",
  "seedream",
  "jimeng",
  // Video generation
  "sora",
  "veo",
  "video",
  "kling",
  "vidu",
  "hailuo",
  "seedance",
  "t2v-",
  "i2v-",
  "s2v-",
  "wan2",
  "wanx",
  // Audio
  "whisper",
  "tts",
  "speech",
  "suno",
  // Embeddings & reranking
  "embedding",
  "embed",
  "rerank",
  "bge-",
  "m3e-",
  // Other non-text
  "image",
  "moderation"
];

// Vendor name patterns for inferring vendor from model name
export const VENDOR_PATTERNS: Record<string, string[]> = {
  anthropic: ["claude"],
  google: ["gemini", "palm"],
  openai: ["gpt", "o1-", "o3-", "o4-", "chatgpt"],
  deepseek: ["deepseek"],
  xai: ["grok"],
  mistral: ["mistral", "codestral"],
  meta: ["llama"],
  alibaba: ["qwen", "qwq-"],
  cohere: ["command-", "c4ai-"],
  minimax: ["abab", "minimax-"],
  moonshot: ["moonshot-", "kimi-"],
  zhipu: ["glm-", "chatglm"],
  perplexity: ["sonar"],
  baidu: ["ernie-"],
  xunfei: ["sparkdesk"],
  tencent: ["hunyuan-"],
  bytedance: ["doubao-"],
  yi: ["yi-"],
  ai360: ["360gpt"]
};

/**
 * Infer channel type from endpoint types.
 */
export function inferChannelType(endpoints: string[]): number {
  if (endpoints.includes("jina-rerank")) return CHANNEL_TYPES.JINA;
  if (endpoints.includes("openai-video")) return CHANNEL_TYPES.SORA;
  if (endpoints.includes("anthropic")) return CHANNEL_TYPES.ANTHROPIC;
  if (endpoints.includes("gemini")) return CHANNEL_TYPES.GEMINI;
  return CHANNEL_TYPES.OPENAI;
}

/**
 * Infer vendor from model name based on known patterns.
 */
export function inferVendorFromModelName(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [vendor, patterns] of Object.entries(VENDOR_PATTERNS)) {
    if (patterns.some((p) => n.includes(p) || n.startsWith(p))) {
      return vendor;
    }
  }
  return undefined;
}

/**
 * Check if a model name matches non-text patterns.
 */
export function matchesNonTextPattern(name: string): boolean {
  const n = name.toLowerCase();
  return NON_TEXT_MODEL_PATTERNS.some((pattern) => n.includes(pattern));
}

/**
 * Check if a model is a text model based on name and optional endpoint info.
 */
export function isTextModel(
  name: string,
  endpoints?: string[],
  modelEndpoints?: Map<string, string[]>
): boolean {
  // Always check pattern matching first - catches misclassified models
  if (matchesNonTextPattern(name)) return false;

  // If we have endpoint info, verify it has text endpoints
  const eps = endpoints ?? modelEndpoints?.get(name);
  if (eps && eps.length > 0) {
    return eps.some((ep) => TEXT_ENDPOINT_TYPES.has(ep));
  }

  // No endpoint info and no pattern match - assume text model
  return true;
}

/**
 * Calculate priority bonus from response time.
 * Formula: 10000 / (avgResponseTime + 100)
 * ~100ms → +50, ~400ms → +20, ~900ms → +10
 */
export function calculatePriorityBonus(avgResponseTime?: number): number {
  if (avgResponseTime === undefined) return 0;
  return Math.round(
    PRIORITY.RESPONSE_TIME_DIVISOR /
      (avgResponseTime + PRIORITY.RESPONSE_TIME_OFFSET)
  );
}

/**
 * Check if a string matches any blacklist pattern (case-insensitive).
 */
export function matchesBlacklist(text: string, blacklist?: string[]): boolean {
  if (!blacklist?.length) return false;
  const t = text.toLowerCase();
  return blacklist.some((pattern) => t.includes(pattern.toLowerCase()));
}

/**
 * Check if a model name matches a glob pattern (supports * wildcard).
 * Examples: "claude-*-4-5*" matches "claude-sonnet-4-5-20251101", "gpt-*" matches "gpt-4o"
 */
export function matchesGlobPattern(name: string, pattern: string): boolean {
  const n = name.toLowerCase();
  const p = pattern.toLowerCase();

  // If no wildcard, do substring match (backward compatible)
  if (!p.includes("*")) {
    return n.includes(p);
  }

  return micromatch.isMatch(n, p);
}

/**
 * Check if a model name matches any of the given patterns (glob or substring).
 */
export function matchesAnyPattern(name: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlobPattern(name, p));
}

/**
 * Removes Chinese characters from a string, keeping only ASCII alphanumeric,
 * hyphens, and underscores. Collapses multiple hyphens into one.
 */
export function sanitizeGroupName(name: string): string {
  return name
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Apply model name mapping. Returns mapped name if exists, otherwise original.
 */
export function applyModelMapping(
  modelName: string,
  mapping?: Record<string, string>
): string {
  return mapping?.[modelName] ?? modelName;
}

/**
 * Retry a function with exponential backoff.
 * @param fn Function to retry
 * @param maxAttempts Maximum retry attempts (default: 3)
 * @param baseDelay Base delay in ms (default: 1000)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = RETRY.MAX_ATTEMPTS,
  baseDelay = RETRY.BASE_DELAY_MS
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) break;

      // Exponential backoff: delay = baseDelay * 2^(attempt-1)
      const delay = Math.min(
        baseDelay * 2 ** (attempt - 1),
        RETRY.MAX_DELAY_MS
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
