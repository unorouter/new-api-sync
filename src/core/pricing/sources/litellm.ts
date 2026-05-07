import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/runtime";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildPricingMaps } from "./build";
import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
  usdPerTokenToRatio,
} from "./types";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

interface LiteLLMEntry {
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_vision?: boolean;
  supports_image_input?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_video_input?: boolean;
  supports_pdf_input?: boolean;
  supports_reasoning?: boolean;
  supports_prompt_caching?: boolean;
  supports_response_schema?: boolean;
  supports_web_search?: boolean;
  supports_computer_use?: boolean;
  supports_assistant_prefill?: boolean;
  supports_code_execution?: boolean;
  supports_file_search?: boolean;
  supports_service_tier?: boolean;
  supports_url_context?: boolean;
  supports_native_streaming?: boolean;
  supports_native_structured_output?: boolean;
  supports_system_messages?: boolean;
  supports_none_reasoning_effort?: boolean;
  supports_minimal_reasoning_effort?: boolean;
  supports_low_reasoning_effort?: boolean;
  supports_max_reasoning_effort?: boolean;
  supports_xhigh_reasoning_effort?: boolean;
  deprecation_date?: string;
}

type LiteLLMResponse = Record<string, LiteLLMEntry | unknown>;

function toPricing(
  key: string,
  entry: LiteLLMEntry,
): BaseModelPricing | undefined {
  const inCost = entry.input_cost_per_token;
  const outCost = entry.output_cost_per_token;
  if (inCost == null || inCost <= 0) return undefined;
  const modelRatio = usdPerTokenToRatio(inCost);
  const completionRatio = outCost && outCost > 0 ? outCost / inCost : 1;
  const pricing: BaseModelPricing = {
    modelRatio,
    completionRatio,
    source: "litellm",
    sourceKey: key,
  };
  if (entry.cache_read_input_token_cost != null) {
    pricing.cacheRatio = entry.cache_read_input_token_cost / inCost;
  }
  if (entry.cache_creation_input_token_cost != null) {
    pricing.createCacheRatio = entry.cache_creation_input_token_cost / inCost;
  }
  return pricing;
}

function toMetadata(entry: LiteLLMEntry): SourceMetadata {
  const md: SourceMetadata = {};
  if (entry.max_input_tokens != null) {
    md.maxInputTokens = entry.max_input_tokens;
    md.contextWindow = entry.max_input_tokens;
  }
  if (entry.max_output_tokens != null)
    md.maxOutputTokens = entry.max_output_tokens;
  else if (entry.max_tokens != null) md.maxOutputTokens = entry.max_tokens;
  if (entry.supports_reasoning != null)
    md.isReasoning = entry.supports_reasoning;
  if (entry.supports_function_calling != null)
    md.supportsTools = entry.supports_function_calling;
  if (entry.supports_parallel_function_calling != null)
    md.supportsParallelTools = entry.supports_parallel_function_calling;
  if (entry.supports_vision != null) md.supportsVision = entry.supports_vision;
  else if (entry.supports_image_input != null)
    md.supportsVision = entry.supports_image_input;
  if (entry.supports_audio_input != null)
    md.supportsAudio = entry.supports_audio_input;
  if (entry.supports_video_input != null)
    md.supportsVideo = entry.supports_video_input;
  if (entry.supports_pdf_input != null)
    md.supportsPdf = entry.supports_pdf_input;
  if (entry.supports_prompt_caching != null)
    md.supportsCache = entry.supports_prompt_caching;
  if (entry.supports_response_schema != null)
    md.supportsResponseFormat = entry.supports_response_schema;
  if (entry.supports_web_search != null)
    md.supportsWebSearch = entry.supports_web_search;
  if (entry.supports_computer_use != null)
    md.supportsComputerUse = entry.supports_computer_use;
  if (entry.supports_assistant_prefill != null)
    md.supportsAssistantPrefill = entry.supports_assistant_prefill;
  if (entry.supports_code_execution != null)
    md.supportsCodeExecution = entry.supports_code_execution;
  if (entry.supports_file_search != null)
    md.supportsFileSearch = entry.supports_file_search;
  if (entry.supports_service_tier != null)
    md.supportsServiceTier = entry.supports_service_tier;
  if (entry.supports_url_context != null)
    md.supportsUrlContext = entry.supports_url_context;
  if (entry.supports_audio_output != null)
    md.supportsAudioOutput = entry.supports_audio_output;
  if (entry.supports_native_streaming != null)
    md.supportsNativeStreaming = entry.supports_native_streaming;
  if (entry.supports_native_structured_output != null)
    md.supportsNativeStructuredOutput = entry.supports_native_structured_output;
  if (entry.supports_system_messages != null)
    md.supportsSystemMessages = entry.supports_system_messages;
  if (entry.mode) md.mode = entry.mode;
  if (entry.deprecation_date) md.deprecationDate = entry.deprecation_date;

  // Reasoning effort granularity. LiteLLM publishes flags for the off-baseline
  // levels (none, minimal, max, xhigh, low). When `low` is supported we infer
  // the OpenAI baseline of {low, medium, high} since they're a single tier in
  // OAI's API. Only emit the array when at least one effort level is known.
  const efforts: NonNullable<SourceMetadata["reasoningEfforts"]> = [];
  if (entry.supports_none_reasoning_effort) efforts.push("none");
  if (entry.supports_minimal_reasoning_effort) efforts.push("minimal");
  if (entry.supports_low_reasoning_effort) {
    efforts.push("low", "medium", "high");
  }
  if (entry.supports_max_reasoning_effort) efforts.push("max");
  if (entry.supports_xhigh_reasoning_effort && !efforts.includes("max")) {
    // xhigh is anthropic-flavored "extreme"; keep as max for the unified UI.
    efforts.push("max");
  }
  if (efforts.length > 0) {
    md.reasoningEfforts = [...new Set(efforts)] as typeof efforts;
  }
  return md;
}

function isLiteLLMEntry(v: unknown): v is LiteLLMEntry {
  return typeof v === "object" && v !== null;
}

/** Fetch + parse LiteLLM model price catalog. */
export async function fetchLiteLLMSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<LiteLLMResponse>(LITELLM_URL, {
    timeoutMs: 15_000,
  });
  if (!raw) {
    consola.warn(t("CORE.PRICING.LITELLM_FETCH_FAILED"));
    return null;
  }

  const validEntries: [string, LiteLLMEntry][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "sample_spec" || !isLiteLLMEntry(value)) continue;
    validEntries.push([key, value]);
  }

  const { pricingMap, metadataMap } = buildPricingMaps({
    entries: validEntries,
    toPricing,
    toMetadata,
  });

  consola.info(
    t("CORE.PRICING.LITELLM_LOADED", {
      pricing: pricingMap.size,
      metadata: metadataMap.size,
    }),
  );

  return {
    name: "litellm",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(metadataMap),
  };
}
