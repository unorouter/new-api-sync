import type { FuzzyIndex } from "@core/catalog/metadata";
import type { PricingSourceName as AllPricingSourceName } from "@core/types";

/** Subset of PricingSourceName that can supply pricing data (excludes "channel"). */
export type PricingSourceName = Exclude<AllPricingSourceName, "channel">;

/**
 * Resolved per-model pricing from a single source.
 *
 * `modelRatio` is in new-api ratio units (USD/M tokens / 2). `completionRatio`,
 * `cacheRatio`, `createCacheRatio` are unitless multipliers relative to the
 * input ratio (e.g. completionRatio=2 means output is 2x the input price).
 */
export interface BaseModelPricing {
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  source: PricingSourceName;
  sourceKey: string;
}

/**
 * Per-source metadata extracted alongside pricing. Merged in priority order
 * by buildModelMetadata; explicit enabledModels[].metadata overrides win.
 *
 * Field name conventions match new-api's models.metadata column consumers
 * (unorouter UI uses these for capability badges + max-token enforcement).
 */
export interface SourceMetadata {
  /** Maximum input context tokens. */
  maxInputTokens?: number;
  /** Maximum output / completion tokens. */
  maxOutputTokens?: number;
  /** Total context window (== maxInputTokens for most models, but separated for clarity). */
  contextWindow?: number;
  /** Model is a reasoning / chain-of-thought model. */
  isReasoning?: boolean;
  /** Supports tool / function calling. */
  supportsTools?: boolean;
  /** Supports image input. */
  supportsVision?: boolean;
  /** Supports audio input. */
  supportsAudio?: boolean;
  /** Supports PDF / document input. */
  supportsPdf?: boolean;
  /** Supports video input. */
  supportsVideo?: boolean;
  /** Supports prompt caching (cache_read pricing exists). */
  supportsCache?: boolean;
  /** Supports response_format / structured output. */
  supportsResponseFormat?: boolean;
  /** Supports parallel tool calls. */
  supportsParallelTools?: boolean;
  /** Supports web search tool. */
  supportsWebSearch?: boolean;
  /** Supports computer use tool (Anthropic). */
  supportsComputerUse?: boolean;
  /** Input modalities the model accepts (e.g. ["text","image","audio"]). */
  inputModalities?: string[];
  /** Output modalities the model produces. */
  outputModalities?: string[];
  /** Tokenizer family (OpenRouter only). */
  tokenizer?: string;
  /** Knowledge cutoff date (ISO string from OpenRouter). */
  knowledgeCutoff?: string;
  /** Deprecation date (LiteLLM only, ISO string). */
  deprecationDate?: string;
  /** Mode of the model: "chat", "embedding", "image", "audio", etc. */
  mode?: string;
  /** Free-form description (OpenRouter / basellm). */
  description?: string;

  // -- Sampler / parameter awareness (OpenRouter-derived) -------------------

  /**
   * Conservative list of OpenAI-compatible parameters supported by ALL
   * upstream endpoints serving this model on OpenRouter (intersection).
   * Drives the unorouter UI's gray-out logic for sampler sliders.
   */
  supportedParameters?: string[];
  /**
   * Permissive list: union of supported_parameters across all OpenRouter
   * endpoints. For an "expert mode" toggle. supportedParameters is a subset.
   */
  supportedParametersAll?: string[];
  /**
   * OpenRouter's default_parameters payload. `null` values flag samplers OR
   * explicitly recommends NOT sending (the model rejects them).
   */
  defaultParameters?: Record<string, number | null>;

  // -- Reasoning effort granularity (LiteLLM-derived) -----------------------

  /** Effort levels the model accepts on `reasoning_effort`. */
  reasoningEfforts?: ("none" | "minimal" | "low" | "medium" | "high" | "max")[];

  // -- Lifecycle / quality --------------------------------------------------

  /** Model EOL date (OpenRouter). */
  expirationDate?: string;
  /** OR's `top_provider.is_moderated` flag. */
  isModerated?: boolean;
  /** Hugging Face model id, when known (OpenRouter). */
  huggingFaceId?: string;
  /** Quantization of the picked OR endpoint (e.g. "fp16", "fp8", "Q4_K_M"). */
  quantization?: string;

  // -- Additional capability flags (LiteLLM) --------------------------------

  /** Supports prefilling the assistant turn (Anthropic-style). */
  supportsAssistantPrefill?: boolean;
  /** Supports server-side code execution tool. */
  supportsCodeExecution?: boolean;
  /** Supports server-side file search tool. */
  supportsFileSearch?: boolean;
  /** Supports OpenAI service-tier routing parameter. */
  supportsServiceTier?: boolean;
  /** Supports OpenAI url_context tool. */
  supportsUrlContext?: boolean;
  /** Supports audio output (e.g. gpt-4o-audio-preview). */
  supportsAudioOutput?: boolean;
  /** Supports native streaming. */
  supportsNativeStreaming?: boolean;
  /** Supports native structured output (JSON schema). */
  supportsNativeStructuredOutput?: boolean;
  /** Supports OpenAI-style system messages role. */
  supportsSystemMessages?: boolean;
}

/**
 * One pricing source after fetch + parse. The fuzzy index lets the resolver
 * match user-supplied model names against this source's keys.
 */
export interface PricingSource {
  name: PricingSourceName;
  pricing: FuzzyIndex<BaseModelPricing>;
  metadata: FuzzyIndex<SourceMetadata>;
}

/** USD per token (LiteLLM format) to new-api ratio (2 USD per quota unit). */
export function usdPerTokenToRatio(usdPerToken: number): number {
  return (usdPerToken * 1_000_000) / 2;
}
