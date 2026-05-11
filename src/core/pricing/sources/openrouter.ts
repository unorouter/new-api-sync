import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import pLimit from "p-limit";
import { buildPricingMaps } from "./build";
import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
  usdPerTokenToRatio,
} from "./types";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_ENDPOINTS_URL = (id: string) =>
  `https://openrouter.ai/api/v1/models/${id}/endpoints`;

/** ~932 req/s sustainable from one IP; 20 is conservative. */
const ENDPOINTS_CONCURRENCY = 20;

/** Summary pricing reflects the cheapest endpoint and absorbs promos — kept for metadata only, never canonical. */
interface OpenRouterSummaryModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
  hugging_face_id?: string | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  /** `null` means OR explicitly says "don't send; the model rejects it" — distinct from absent. */
  default_parameters?: Record<string, number | null>;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
}

interface OpenRouterEndpoint {
  provider_name: string;
  quantization?: string;
  /** Per-endpoint list — intersect across endpoints for the safe set (Bedrock-Claude excludes samplers Anthropic-direct exposes). */
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
    /** effective_price = price * (1 - discount). */
    discount?: number;
  };
}

interface OpenRouterEndpointsResponse {
  data?: {
    id: string;
    endpoints?: OpenRouterEndpoint[];
  };
}

export interface OpenRouterEndpointsTrace {
  id: string;
  endpoints: Array<{
    provider: string;
    quantization?: string;
    supportedParameters?: string[];
    prompt: number;
    completion: number;
    discount: number;
    effectivePrompt: number;
    effectiveCompletion: number;
  }>;
  picked?: {
    provider: string;
    promptUsd: number;
    completionUsd: number;
    quantization?: string;
  };
}

const endpointTraces = new Map<string, OpenRouterEndpointsTrace>();

export function getOpenRouterEndpointsTrace(
  id: string,
): OpenRouterEndpointsTrace | undefined {
  return endpointTraces.get(id);
}

function parseUsdPerToken(s: string | undefined): number | undefined {
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** supportedParameters (intersection) + supportedParametersAll (union) come from the per-endpoint trace; the model-level union lies when one endpoint accepts a sampler nobody else does. */
function toMetadata(model: OpenRouterSummaryModel): SourceMetadata {
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
      params.includes("response_format") ||
      params.includes("structured_outputs");
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
  if (model.architecture?.tokenizer)
    md.tokenizer = model.architecture.tokenizer;
  if (model.pricing?.input_cache_read) md.supportsCache = true;
  if (model.knowledge_cutoff) md.knowledgeCutoff = model.knowledge_cutoff;
  if (model.description) md.description = model.description;
  if (model.expiration_date) md.expirationDate = model.expiration_date;
  if (model.top_provider?.is_moderated != null)
    md.isModerated = model.top_provider.is_moderated;
  if (model.hugging_face_id) md.huggingFaceId = model.hugging_face_id;
  if (model.default_parameters && Object.keys(model.default_parameters).length)
    md.defaultParameters = model.default_parameters;

  // Intersect/union per-endpoint supported_parameters; fall back to model-level union below.
  const trace = endpointTraces.get(model.id);
  if (trace?.endpoints && trace.endpoints.length > 0) {
    const lists = trace.endpoints
      .map((e) => e.supportedParameters)
      .filter((l): l is string[] => Array.isArray(l) && l.length > 0);
    if (lists.length > 0) {
      const union = new Set<string>();
      for (const l of lists) for (const p of l) union.add(p);
      const intersection = lists.reduce<Set<string>>(
        (acc, l) => new Set(l.filter((p) => acc.has(p))),
        new Set(lists[0]),
      );
      md.supportedParametersAll = [...union].sort();
      md.supportedParameters = [...intersection].sort();
    }
    if (trace.picked?.quantization)
      md.quantization = trace.picked.quantization;
  }
  // No per-endpoint data: intersection == union from the model-level view.
  if (!md.supportedParameters && params.length > 0) {
    md.supportedParameters = [...params].sort();
    md.supportedParametersAll = md.supportedParameters;
  }
  return md;
}

/**
 * Median prompt/completion across endpoints. Max would import single-endpoint
 * outliers (Venice at $1.75 vs 11×$1.40 for glm-5.1); min would import promos
 * (DeepSeek-direct $0.435/M vs $1.74 cluster for V4-Pro). Median tracks the
 * dominant cluster.
 */
function pickCanonicalEndpoint(endpoints: OpenRouterEndpoint[]):
  | {
      promptUsd: number;
      completionUsd: number;
      provider: string;
      quantization?: string;
    }
  | undefined {
  // completion is paired per-row so the median row's completion is used (not a separate completion median).
  interface Row {
    prompt: number;
    completion: number;
    provider: string;
    quantization?: string;
  }
  const rows: Row[] = [];
  for (const ep of endpoints) {
    const prompt = parseUsdPerToken(ep.pricing?.prompt);
    if (prompt == null || prompt <= 0) continue;
    const discount = ep.pricing?.discount ?? 0;
    const effectivePrompt = prompt * (1 - discount);
    const completion = parseUsdPerToken(ep.pricing?.completion);
    const effectiveCompletion =
      completion != null ? completion * (1 - discount) : effectivePrompt;
    rows.push({
      prompt: effectivePrompt,
      completion: effectiveCompletion,
      provider: ep.provider_name,
      quantization: ep.quantization,
    });
  }
  if (rows.length === 0) return undefined;

  // Even counts: upper-middle (some provider's actual price), not a synthetic mean.
  rows.sort((a, b) => a.prompt - b.prompt);
  const medianRow = rows[Math.floor(rows.length / 2)]!;
  return {
    promptUsd: medianRow.prompt,
    completionUsd: medianRow.completion,
    provider: medianRow.provider,
    quantization: medianRow.quantization,
  };
}

async function fetchEndpointsForModel(
  id: string,
): Promise<OpenRouterEndpointsTrace | null> {
  const raw = await tryFetchJson<OpenRouterEndpointsResponse>(
    OPENROUTER_ENDPOINTS_URL(id),
    { timeoutMs: 10_000 },
  );
  if (!raw?.data?.endpoints || raw.data.endpoints.length === 0) return null;

  const trace: OpenRouterEndpointsTrace = {
    id,
    endpoints: [],
  };
  for (const ep of raw.data.endpoints) {
    const prompt = parseUsdPerToken(ep.pricing?.prompt);
    const completion = parseUsdPerToken(ep.pricing?.completion);
    if (prompt == null || prompt <= 0) continue;
    const discount = ep.pricing?.discount ?? 0;
    trace.endpoints.push({
      provider: ep.provider_name,
      quantization: ep.quantization,
      supportedParameters: ep.supported_parameters,
      prompt,
      completion: completion ?? prompt,
      discount,
      effectivePrompt: prompt * (1 - discount),
      effectiveCompletion: (completion ?? prompt) * (1 - discount),
    });
  }
  if (trace.endpoints.length === 0) return null;

  const picked = pickCanonicalEndpoint(raw.data.endpoints);
  if (picked) trace.picked = picked;
  return trace;
}

/** Two-phase: /v1/models for metadata, then /v1/models/{id}/endpoints (concurrent) for per-provider pricing → median per model. */
export async function fetchOpenRouterPricingSource(): Promise<PricingSource | null> {
  endpointTraces.clear();

  const summary = await tryFetchJson<{ data?: OpenRouterSummaryModel[] }>(
    OPENROUTER_MODELS_URL,
    { timeoutMs: 15_000 },
  );
  if (!summary?.data || !Array.isArray(summary.data)) {
    consola.warn(t("CORE.PRICING.OPENROUTER_FETCH_FAILED"));
    return null;
  }

  const summaryById = new Map<string, OpenRouterSummaryModel>();
  for (const m of summary.data) {
    if (m.id) summaryById.set(m.id, m);
  }

  const ids = [...summaryById.keys()];
  consola.info(
    t("CORE.PRICING.OPENROUTER_FETCHING_ENDPOINTS", {
      count: ids.length,
      concurrency: ENDPOINTS_CONCURRENCY,
    }),
  );

  const t0 = performance.now();
  const limit = pLimit(ENDPOINTS_CONCURRENCY);
  const results = await Promise.all(
    ids.map((id) => limit(() => fetchEndpointsForModel(id))),
  );
  const dt = Math.round(performance.now() - t0);

  let withEndpoints = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const trace = results[i];
    if (trace) {
      endpointTraces.set(id, trace);
      withEndpoints++;
    }
  }
  consola.info(
    t("CORE.PRICING.OPENROUTER_PREFETCH_DONE", {
      with: withEndpoints,
      total: ids.length,
      dt,
    }),
  );

  const validEntries: [string, OpenRouterSummaryModel][] = [];
  for (const [id, model] of summaryById) {
    if (!endpointTraces.has(id)) continue;
    validEntries.push([id, model]);
  }

  const toPricing = (
    _key: string,
    model: OpenRouterSummaryModel,
  ): BaseModelPricing | undefined => {
    const trace = endpointTraces.get(model.id);
    if (!trace?.picked) return undefined;
    const inCost = trace.picked.promptUsd;
    const outCost = trace.picked.completionUsd;
    if (inCost <= 0) return undefined;
    return {
      modelRatio: usdPerTokenToRatio(inCost),
      completionRatio: outCost > 0 ? outCost / inCost : 1,
      source: "openrouter",
      sourceKey: model.id,
    };
  };

  const { pricingMap, metadataMap } = buildPricingMaps({
    entries: validEntries,
    toPricing,
    toMetadata,
  });

  consola.info(
    t("CORE.PRICING.OPENROUTER_LOADED", {
      pricing: pricingMap.size,
      metadata: metadataMap.size,
    }),
  );

  return {
    name: "openrouter",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(metadataMap),
  };
}
