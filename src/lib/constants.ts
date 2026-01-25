/**
 * Centralized constants for the sync application.
 * Extracted from scattered magic numbers across the codebase.
 */

// Pagination configuration
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 100,
  START_PAGE_ZERO: 0,
  START_PAGE_ONE: 1,
} as const;

// Timeout configuration (milliseconds)
export const TIMEOUTS = {
  MODEL_TEST_MS: 10000,
} as const;

// Channel type identifiers from new-api
export const CHANNEL_TYPES = {
  OPENAI: 1,
  ANTHROPIC: 14,
  GEMINI: 24,
  JINA_RERANK: 38,
  OPENAI_VIDEO: 55,
} as const;

// Priority calculation constants
export const PRIORITY = {
  RESPONSE_TIME_DIVISOR: 10000,
  RESPONSE_TIME_OFFSET: 100,
} as const;

// Text endpoint types from new-api (openai, anthropic, gemini, openai-response)
// Non-text types: image-generation, embeddings, openai-video, jina-rerank
export const TEXT_ENDPOINT_TYPES = new Set([
  "openai",
  "anthropic",
  "gemini",
  "openai-response",
]);

// Patterns that indicate non-text models (image, video, audio, embedding)
export const NON_TEXT_MODEL_PATTERNS = [
  "sora",
  "veo",
  "video",
  "image",
  "dall-e",
  "dalle",
  "midjourney",
  "stable-diffusion",
  "flux",
  "imagen",
  "whisper",
  "tts",
  "speech",
  "embedding",
  "embed",
  "moderation",
  "rerank",
];

// Vendor name patterns for inferring vendor from model name
export const VENDOR_PATTERNS: Record<string, string[]> = {
  anthropic: ["claude", "anthropic"],
  google: ["gemini", "palm"],
  openai: ["gpt", "o1-", "o3-", "o4-", "chatgpt"],
  deepseek: ["deepseek"],
  xai: ["grok"],
  mistral: ["mistral", "codestral"],
  meta: ["llama", "meta-"],
  alibaba: ["qwen"],
};

/**
 * Infer channel type from endpoint types.
 */
export function inferChannelType(endpoints: string[]): number {
  if (endpoints.includes("jina-rerank")) return CHANNEL_TYPES.JINA_RERANK;
  if (endpoints.includes("openai-video")) return CHANNEL_TYPES.OPENAI_VIDEO;
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
  modelEndpoints?: Map<string, string[]>,
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
    PRIORITY.RESPONSE_TIME_DIVISOR / (avgResponseTime + PRIORITY.RESPONSE_TIME_OFFSET),
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
 * Examples: "claude-*-4-5" matches "claude-sonnet-4-5", "gpt-*" matches "gpt-4o"
 */
export function matchesGlobPattern(name: string, pattern: string): boolean {
  const n = name.toLowerCase();
  const p = pattern.toLowerCase();

  // If no wildcard, do substring match (backward compatible)
  if (!p.includes("*")) {
    return n.includes(p);
  }

  // Convert glob to regex: escape special chars, replace * with .*
  const regexStr = p
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(n);
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
