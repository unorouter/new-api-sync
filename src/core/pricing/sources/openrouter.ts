import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/runtime/http";
import { consola } from "consola";
import { buildPricingMaps } from "./build";
import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
  usdPerTokenToRatio,
} from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  knowledge_cutoff?: string | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    image?: string;
    audio?: string;
    web_search?: string;
    internal_reasoning?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
}

interface OpenRouterResponse {
  data?: OpenRouterModel[];
}

function parseUsdPerToken(s: string | undefined): number | undefined {
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function toPricing(model: OpenRouterModel): BaseModelPricing | undefined {
  const inCost = parseUsdPerToken(model.pricing?.prompt);
  if (inCost == null || inCost <= 0) return undefined;
  const outCost = parseUsdPerToken(model.pricing?.completion);
  const completionRatio = outCost && outCost > 0 ? outCost / inCost : 1;
  const pricing: BaseModelPricing = {
    modelRatio: usdPerTokenToRatio(inCost),
    completionRatio,
    source: "openrouter",
    sourceKey: model.id,
  };
  const cacheRead = parseUsdPerToken(model.pricing?.input_cache_read);
  if (cacheRead != null) pricing.cacheRatio = cacheRead / inCost;
  const cacheWrite = parseUsdPerToken(model.pricing?.input_cache_write);
  if (cacheWrite != null) pricing.createCacheRatio = cacheWrite / inCost;
  return pricing;
}

function toMetadata(model: OpenRouterModel): SourceMetadata {
  const md: SourceMetadata = {};
  const ctx = model.top_provider?.context_length ?? model.context_length;
  if (ctx != null) {
    md.maxInputTokens = ctx;
    md.contextWindow = ctx;
  }
  if (model.top_provider?.max_completion_tokens != null) {
    md.maxOutputTokens = model.top_provider.max_completion_tokens;
  }
  const params = model.supported_parameters ?? [];
  if (params.length > 0) {
    md.supportsTools = params.includes("tools");
    md.supportsParallelTools = params.includes("parallel_tool_calls");
    md.isReasoning =
      params.includes("reasoning") || params.includes("include_reasoning");
    md.supportsResponseFormat =
      params.includes("response_format") || params.includes("structured_outputs");
    md.supportsWebSearch = params.includes("web_search_options");
  }
  const inputs = model.architecture?.input_modalities ?? [];
  const outputs = model.architecture?.output_modalities ?? [];
  if (inputs.length > 0) {
    md.inputModalities = inputs;
    md.supportsVision = inputs.includes("image");
    md.supportsAudio = inputs.includes("audio");
    md.supportsVideo = inputs.includes("video");
    md.supportsPdf = inputs.includes("file");
  }
  if (outputs.length > 0) md.outputModalities = outputs;
  if (model.architecture?.tokenizer) md.tokenizer = model.architecture.tokenizer;
  if (model.pricing?.input_cache_read) md.supportsCache = true;
  if (model.knowledge_cutoff) md.knowledgeCutoff = model.knowledge_cutoff;
  if (model.description) md.description = model.description;
  return md;
}

/** Fetch + parse OpenRouter model catalog (live pricing). */
export async function fetchOpenRouterPricingSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<OpenRouterResponse>(OPENROUTER_URL, {
    timeoutMs: 15_000,
  });
  if (!raw?.data || !Array.isArray(raw.data)) {
    consola.warn("[pricing] failed to fetch OpenRouter catalog");
    return null;
  }

  const validEntries: [string, OpenRouterModel][] = [];
  for (const model of raw.data) {
    if (!model.id) continue;
    validEntries.push([model.id, model]);
  }

  const { pricingMap, metadataMap } = buildPricingMaps({
    entries: validEntries,
    toPricing: (_key, model) => toPricing(model),
    toMetadata,
  });

  consola.info(
    `[pricing] OpenRouter loaded ${pricingMap.size} pricing entries, ${metadataMap.size} metadata entries`,
  );

  return {
    name: "openrouter",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(metadataMap),
  };
}
