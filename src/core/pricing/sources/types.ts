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
  /** What a MAJORITY of endpoints accept - drives UI gray-out for sliders. */
  supportedParameters?: string[];
  /** Union across endpoints - "expert mode". */
  supportedParametersAll?: string[];
  /** Per-host lists, so a pinned lane can be checked exactly. */
  supportedParametersByHost?: Record<string, string[]>;
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

  // ─── Runware (image models) ───
  /**
   * Which generation controls the model accepts, from Runware's own per-model
   * schema. A param absent from the schema is rejected upstream, so a client
   * rendering a control for it can only produce a failed generation.
   */
  imageParams?: ImageParams;
}

/** Slider bounds and default for one numeric generation parameter. */
export interface ImageParamRange {
  min?: number;
  max?: number;
  default?: number;
}

export interface ImageParams {
  supportsNegativePrompt: boolean;
  supportsCfg: boolean;
  supportsSteps: boolean;
  supportsSampler: boolean;
  supportsLoraChain: boolean;
  supportsSeed: boolean;
  supportsStrength: boolean;
  supportsHiresFix: boolean;
  supportsAdetailer: boolean;
  /** Accepted `<sampler> <schedule>` strings; Runware folds both into one field. */
  samplers?: string[];
  steps?: ImageParamRange;
  cfg?: ImageParamRange;
  /** inputs.referenceImages.maxItems: 0 means the model takes none. */
  maxReferenceImages: number;
  supportsSeedImage: boolean;
  supportsMaskImage: boolean;
  /** Provider-scoped enums, so the choices offered are the ones it accepts. */
  outputFormatChoices?: string[];
  qualityChoices?: string[];
  backgroundChoices?: string[];
  /**
   * The endpoint a synchronous image request routes to, resolved once here so no
   * caller re-derives it from the endpoint-type list. Absent when the model serves
   * none of them (an aihorde-only row), which is what makes it unsubmittable.
   */
  endpoint?: "image-generation" | "openai" | "gemini";
  /** Width/height a form starts at, and whether the model accepts them at all. */
  supportsSize: boolean;
  defaultWidth: number;
  defaultHeight: number;
  defaultSteps: number;
  defaultCfg?: number;
  defaultSampler: string;
}

// What resolveSourceMetadata returns: the merged source data plus releaseTs,
// which it always derives. Sources supply releaseDate; only the resolver can
// promise the epoch is there.
export type ResolvedMetadata = SourceMetadata & { releaseTs: number };

export interface PricingSource {
  name: PricingSourceName;
  pricing: FuzzyIndex<BaseModelPricing>;
  metadata: FuzzyIndex<SourceMetadata>;
}

/** LiteLLM's USD/token → new-api ratio (2 USD per quota unit). */
export function usdPerTokenToRatio(usdPerToken: number): number {
  return (usdPerToken * 1_000_000) / 2;
}
