import type { PriceAdjustment } from "@/lib/types";
import micromatch from "micromatch";

// Managed option keys for sync
export const MANAGED_OPTION_KEYS = [
  "GroupRatio",
  "UserUsableGroups",
  "AutoGroups",
  "DefaultUseAutoGroup",
  "ModelRatio",
  "CompletionRatio",
  "global.chat_completions_to_responses_policy",
] as const;

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

// Default paths for endpoint types (mirrors new-api's endpoint_defaults.go)
export const ENDPOINT_DEFAULT_PATHS: Record<string, string> = {
  openai: "/v1/chat/completions",
  "openai-response": "/v1/responses",
  "openai-response-compact": "/v1/responses/compact",
  anthropic: "/v1/messages",
  gemini: "/v1beta/models/{model}:generateContent",
  "jina-rerank": "/v1/rerank",
  "image-generation": "/v1/images/generations",
  embedding: "/v1/embeddings"
};

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

export const VENDOR_MATCHERS: Record<string, {
  modelPatterns: string[];
  nameAliases?: string[];
}> = {
  anthropic: { modelPatterns: ["claude"] },
  google: { modelPatterns: ["gemini", "palm"] },
  openai: { modelPatterns: ["gpt", "o1-", "o3-", "o4-", "chatgpt"] },
  deepseek: { modelPatterns: ["deepseek"] },
  xai: { modelPatterns: ["grok"] },
  mistral: { modelPatterns: ["mistral", "codestral"] },
  meta: { modelPatterns: ["llama"] },
  alibaba: {
    modelPatterns: ["qwen", "qwq-"],
    nameAliases: ["阿里", "通义", "qwen"],
  },
  cohere: { modelPatterns: ["command-", "c4ai-"] },
  minimax: { modelPatterns: ["abab", "minimax-"] },
  moonshot: {
    modelPatterns: ["moonshot-", "kimi-"],
    nameAliases: ["月之暗面", "kimi"],
  },
  zhipu: {
    modelPatterns: ["glm-", "chatglm"],
    nameAliases: ["智谱", "zhipu ai", "chatglm"],
  },
  perplexity: { modelPatterns: ["sonar"] },
  baidu: {
    modelPatterns: ["ernie-"],
    nameAliases: ["百度", "文心"],
  },
  xunfei: {
    modelPatterns: ["sparkdesk"],
    nameAliases: ["讯飞", "spark"],
  },
  tencent: {
    modelPatterns: ["hunyuan-"],
    nameAliases: ["腾讯", "混元"],
  },
  bytedance: {
    modelPatterns: ["doubao-"],
    nameAliases: ["字节", "豆包", "doubao"],
  },
  yi: { modelPatterns: ["yi-"] },
  ai360: { modelPatterns: ["360gpt"] },
};

export const SUB2API_PLATFORM_CHANNEL_TYPES: Record<string, number> = {
  anthropic: CHANNEL_TYPES.ANTHROPIC,
  gemini: CHANNEL_TYPES.GEMINI,
  openai: CHANNEL_TYPES.OPENAI,
};

export const VENDOR_TO_SUB2API_PLATFORMS: Record<string, string[]> = {
  google: ["gemini", "antigravity"],
  anthropic: ["anthropic"],
  openai: ["openai"],
};

export const SUB2API_PLATFORM_TO_VENDOR: Record<string, string> = Object.fromEntries(
  Object.entries(VENDOR_TO_SUB2API_PLATFORMS).flatMap(([vendor, platforms]) =>
    platforms.map((platform) => [platform, vendor]),
  ),
);

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
 * Infer channel type from model names using vendor detection.
 * Falls back to endpoint-based inference if vendor can't be determined.
 * This avoids misclassification when models support multiple endpoint types
 * (e.g. GPT models with both openai and anthropic endpoints).
 */
export function inferChannelTypeFromModels(
  models: string[],
  modelEndpoints: Map<string, string[]>,
): number {
  // Count vendor occurrences among the models
  const vendorCounts = new Map<string, number>();
  for (const model of models) {
    const vendor = inferVendorFromModelName(model);
    if (vendor) {
      vendorCounts.set(vendor, (vendorCounts.get(vendor) ?? 0) + 1);
    }
  }

  // Pick the most common vendor
  let topVendor: string | undefined;
  let topCount = 0;
  for (const [vendor, count] of vendorCounts) {
    if (count > topCount) {
      topVendor = vendor;
      topCount = count;
    }
  }

  // Map vendor to channel type via registry
  if (topVendor) {
    const vendorInfo = VENDOR_REGISTRY[topVendor];
    if (vendorInfo) {
      return vendorInfo.channelType;
    }
  }

  // Fallback: use endpoint-based inference from filtered models
  const endpoints = new Set<string>();
  for (const model of models) {
    const eps = modelEndpoints.get(model);
    if (eps) {
      for (const ep of eps) endpoints.add(ep);
    }
  }
  if (endpoints.size > 0) {
    return inferChannelType(Array.from(endpoints));
  }

  return CHANNEL_TYPES.OPENAI;
}

/**
 * Infer vendor from model name based on known patterns.
 */
export function inferVendorFromModelName(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [vendor, matcher] of Object.entries(VENDOR_MATCHERS)) {
    if (matcher.modelPatterns.some((p) => n.includes(p) || n.startsWith(p))) {
      return vendor;
    }
  }
  return undefined;
}

export function sub2ApiPlatformToChannelType(platform: string): number {
  return SUB2API_PLATFORM_CHANNEL_TYPES[platform.toLowerCase()] ?? CHANNEL_TYPES.OPENAI;
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
 *
 * Patterns containing "/" are scoped: "provider/pattern" only matches when
 * the given `scope` equals the provider part (before the slash) and the text
 * contains the pattern part (after the slash).  Patterns without "/" match
 * any scope as before.
 */
export function matchesBlacklist(text: string, blacklist?: string[], scope?: string): boolean {
  if (!blacklist?.length) return false;
  const t = text.toLowerCase();
  const s = scope?.toLowerCase();
  return blacklist.some((raw) => {
    const pattern = raw.toLowerCase();
    const slashIdx = pattern.indexOf("/");
    if (slashIdx !== -1 && s !== undefined) {
      const scopePart = pattern.slice(0, slashIdx);
      const textPart = pattern.slice(slashIdx + 1);
      return s === scopePart && t.includes(textPart);
    }
    // Unscoped pattern or no scope provided — skip scoped patterns
    if (slashIdx !== -1) return false;
    return t.includes(pattern);
  });
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
 * Resolve a PriceAdjustment value for a specific vendor.
 * - undefined → 0
 * - number → return as-is
 * - Record → lookup vendor key (lowercased), fallback to "default" key
 */
export function resolvePriceAdjustment(adjustment: PriceAdjustment | undefined, vendor: string): number {
  if (adjustment === undefined) return 0;
  if (typeof adjustment === "number") return adjustment;
  return adjustment[vendor.toLowerCase()] ?? adjustment["default"] ?? 0;
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
