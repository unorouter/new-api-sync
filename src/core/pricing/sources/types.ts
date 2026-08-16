import type { FuzzyIndex } from "@core/catalog/metadata";
import type { PricingSourceName as AllPricingSourceName } from "@core/types";

/** Excludes "channel" (channels supply pricing differently). */
export type PricingSourceName = Exclude<AllPricingSourceName, "channel">;

/** modelRatio is new-api units (USD/M tokens / 2); completion/cache are multipliers vs input. */
export interface BaseModelPricing {
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  source: PricingSourceName;
  sourceKey: string;
}

/** Merged in priority order; enabledModels[].metadata overrides win. Fields mirror new-api's models.metadata column. */
export interface SourceMetadata {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  isReasoning?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  supportsPdf?: boolean;
  supportsVideo?: boolean;
  /** cache_read pricing exists */
  supportsCache?: boolean;
  supportsResponseFormat?: boolean;
  supportsParallelTools?: boolean;
  supportsWebSearch?: boolean;
  /** Anthropic computer use */
  supportsComputerUse?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  /** OpenRouter */
  tokenizer?: string;
  /** ISO string (OpenRouter) */
  knowledgeCutoff?: string;
  /** ISO string, model release date (OpenRouter `created`) */
  releaseDate?: string;
  /** Epoch ms derived from releaseDate at resolve time; consumers sort on this. */
  releaseTs?: number;
  /** Model family/series, e.g. "Claude" / "GPT" / "Gemini" (OpenRouter `group`). */
  series?: string;
  /** Usage categories, e.g. ["programming","roleplay"] (OpenRouter cards). */
  categories?: string[];
  /** ISO string (LiteLLM) */
  deprecationDate?: string;
  /** "chat" | "embedding" | "image" | "audio" | ... */
  mode?: string;
  description?: string;

  // ─── Sampler awareness (OpenRouter) ───
  /** Intersection across endpoints — drives UI gray-out for sliders. */
  supportedParameters?: string[];
  /** Union across endpoints — "expert mode". */
  supportedParametersAll?: string[];
  /** `null` = OR recommends NOT sending (model rejects). */
  defaultParameters?: Record<string, number | null>;

  // ─── LiteLLM ───
  reasoningEfforts?: ("none" | "minimal" | "low" | "medium" | "high" | "max")[];

  // ─── Lifecycle / quality ───
  /** OpenRouter EOL */
  expirationDate?: string;
  isModerated?: boolean;
  huggingFaceId?: string;
  /** OR picked endpoint: fp16, fp8, Q4_K_M, ... */
  quantization?: string;

  // ─── LiteLLM extras ───
  supportsAssistantPrefill?: boolean;
  supportsCodeExecution?: boolean;
  supportsFileSearch?: boolean;
  supportsServiceTier?: boolean;
  supportsUrlContext?: boolean;
  supportsAudioOutput?: boolean;
  supportsNativeStreaming?: boolean;
  supportsNativeStructuredOutput?: boolean;
  supportsSystemMessages?: boolean;
}

export interface PricingSource {
  name: PricingSourceName;
  pricing: FuzzyIndex<BaseModelPricing>;
  metadata: FuzzyIndex<SourceMetadata>;
}

/** LiteLLM's USD/token → new-api ratio (2 USD per quota unit). */
export function usdPerTokenToRatio(usdPerToken: number): number {
  return (usdPerToken * 1_000_000) / 2;
}
