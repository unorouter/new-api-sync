import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/infra/http";
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
  supports_vision?: boolean;
  supports_image_input?: boolean;
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
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
  const pricing: BaseModelPricing = {
    modelRatio: usdPerTokenToRatio(inCost),
    completionRatio: outCost && outCost > 0 ? outCost / inCost : 1,
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

// prettier-ignore
const BOOL_FIELD_MAP: Array<[keyof LiteLLMEntry, keyof SourceMetadata]> = [["supports_reasoning","isReasoning"],["supports_function_calling","supportsTools"],["supports_parallel_function_calling","supportsParallelTools"],["supports_audio_input","supportsAudio"],["supports_video_input","supportsVideo"],["supports_pdf_input","supportsPdf"],["supports_prompt_caching","supportsCache"],["supports_response_schema","supportsResponseFormat"],["supports_web_search","supportsWebSearch"],["supports_computer_use","supportsComputerUse"],["supports_assistant_prefill","supportsAssistantPrefill"],["supports_code_execution","supportsCodeExecution"],["supports_file_search","supportsFileSearch"],["supports_service_tier","supportsServiceTier"],["supports_url_context","supportsUrlContext"],["supports_audio_output","supportsAudioOutput"],["supports_native_streaming","supportsNativeStreaming"],["supports_native_structured_output","supportsNativeStructuredOutput"],["supports_system_messages","supportsSystemMessages"]];

function toMetadata(entry: LiteLLMEntry): SourceMetadata {
  const md: SourceMetadata = {};
  if (entry.max_input_tokens != null) {
    md.maxInputTokens = entry.max_input_tokens;
    md.contextWindow = entry.max_input_tokens;
  }
  if (entry.max_output_tokens != null)
    md.maxOutputTokens = entry.max_output_tokens;
  else if (entry.max_tokens != null) md.maxOutputTokens = entry.max_tokens;
  if (entry.supports_vision != null) md.supportsVision = entry.supports_vision;
  else if (entry.supports_image_input != null)
    md.supportsVision = entry.supports_image_input;
  for (const [from, to] of BOOL_FIELD_MAP) {
    const v = entry[from];
    if (v != null) (md as Record<string, unknown>)[to] = v;
  }
  if (entry.mode) md.mode = entry.mode;
  if (entry.deprecation_date) md.deprecationDate = entry.deprecation_date;

  const efforts: NonNullable<SourceMetadata["reasoningEfforts"]> = [];
  if (entry.supports_none_reasoning_effort) efforts.push("none");
  if (entry.supports_minimal_reasoning_effort) efforts.push("minimal");
  if (entry.supports_low_reasoning_effort)
    efforts.push("low", "medium", "high");
  if (entry.supports_max_reasoning_effort) efforts.push("max");
  if (entry.supports_xhigh_reasoning_effort && !efforts.includes("max"))
    efforts.push("max");
  if (efforts.length > 0) {
    md.reasoningEfforts = [...new Set(efforts)] as typeof efforts;
  }
  return md;
}

function isLiteLLMEntry(v: unknown): v is LiteLLMEntry {
  return typeof v === "object" && v !== null;
}

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
