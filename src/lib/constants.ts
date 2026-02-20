import micromatch from "micromatch";

// Managed option keys for sync
export const MANAGED_OPTION_KEYS = [
  "GroupRatio",
  "UserUsableGroups",
  "AutoGroups",
  "DefaultUseAutoGroup",
  "ModelRatio",
  "CompletionRatio",
  "ModelPrice",
  "ImageRatio",
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

// Vendor name → channel type mapping
export const VENDOR_CHANNEL_TYPES: Record<string, number> = {
  openai: CHANNEL_TYPES.OPENAI,
  anthropic: CHANNEL_TYPES.ANTHROPIC,
  google: CHANNEL_TYPES.GEMINI,
  deepseek: CHANNEL_TYPES.DEEPSEEK,
  moonshot: CHANNEL_TYPES.MOONSHOT,
  mistral: CHANNEL_TYPES.MISTRAL,
  xai: CHANNEL_TYPES.XAI,
  siliconflow: CHANNEL_TYPES.SILICONFLOW,
  cohere: CHANNEL_TYPES.COHERE,
  zhipu: CHANNEL_TYPES.ZHIPU_V4,
  volcengine: CHANNEL_TYPES.VOLCENGINE,
  minimax: CHANNEL_TYPES.MINIMAX,
  perplexity: CHANNEL_TYPES.PERPLEXITY,
};

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
    const channelType = VENDOR_CHANNEL_TYPES[topVendor];
    if (channelType !== undefined) {
      return channelType;
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

// Endpoint types that indicate a model should NOT be tested with chat completions.
const NON_TESTABLE_ENDPOINT_TYPES = new Set([
  "image-generation",
  "dall-e-3",
  "embeddings",
  "openai-video",
  "jina-rerank",
]);

/**
 * Check if a model can be tested with the current test harness.
 * Models with non-testable endpoints are skipped even if they also have text endpoints.
 * Without endpoint data, falls back to name pattern matching.
 */
export function isTestableModel(
  name: string,
  endpoints?: string[],
  modelEndpoints?: Map<string, string[]>
): boolean {
  const eps = endpoints ?? modelEndpoints?.get(name);
  if (eps && eps.length > 0) {
    if (eps.some((ep) => NON_TESTABLE_ENDPOINT_TYPES.has(ep))) return false;
    return eps.some((ep) => TEXT_ENDPOINT_TYPES.has(ep));
  }
  const n = name.toLowerCase();
  return !NON_TEXT_MODEL_PATTERNS.some((p) => n.includes(p));
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
 * Check if a model name matches any of the given patterns (glob or substring).
 */
export function matchesAnyPattern(name: string, patterns: string[]): boolean {
  const n = name.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    if (!p.includes("*")) return n.includes(p);
    return micromatch.isMatch(n, p);
  });
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
