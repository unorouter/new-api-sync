import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/runtime";
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

/**
 * Concurrency for the per-model /endpoints fan-out. Probe runs showed ~932
 * req/s sustainable from one IP with zero rate-limit headers exposed; 20 is
 * conservative. Bump only if total sync wall-time becomes a concern.
 */
const ENDPOINTS_CONCURRENCY = 20;

/**
 * Pricing fields on the /v1/models summary response. We intentionally do NOT
 * use these for canonical pricing — they reflect the *cheapest* endpoint and
 * silently absorb provider-side promos (e.g. DeepSeek's 75% off-peak shows up
 * as the base "prompt" price). Kept only for shape compatibility / metadata.
 */
interface OpenRouterSummaryModel {
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
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  supported_parameters?: string[];
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
}

interface OpenRouterEndpoint {
  name: string;
  provider_name: string;
  tag?: string;
  quantization?: string;
  context_length?: number;
  max_completion_tokens?: number | null;
  status?: number;
  pricing?: {
    /** USD per token for input / prompt. */
    prompt?: string;
    /** USD per token for output / completion. */
    completion?: string;
    input_cache_read?: string;
    /** Multiplier applied as effective_price = price * (1 - discount). 0 = no further discount. */
    discount?: number;
  };
}

interface OpenRouterEndpointsResponse {
  data?: {
    id: string;
    endpoints?: OpenRouterEndpoint[];
  };
}

/** Trace data captured per model for debug logging. */
export interface OpenRouterEndpointsTrace {
  id: string;
  endpoints: Array<{
    provider: string;
    quantization?: string;
    prompt: number;
    completion: number;
    discount: number;
    /** prompt * (1 - discount) — the effective per-token cost. */
    effectivePrompt: number;
    /** completion * (1 - discount). */
    effectiveCompletion: number;
  }>;
  /** The endpoint we picked as canonical (max effectivePrompt, status >= 0). */
  picked?: {
    provider: string;
    promptUsd: number;
    completionUsd: number;
  };
}

/** Module-level trace store, populated during fetch and consumed by testing logs. */
const endpointTraces = new Map<string, OpenRouterEndpointsTrace>();

export function getOpenRouterEndpointsTrace(
  id: string,
): OpenRouterEndpointsTrace | undefined {
  return endpointTraces.get(id);
}

export function getAllOpenRouterEndpointsTraces(): Map<
  string,
  OpenRouterEndpointsTrace
> {
  return endpointTraces;
}

function parseUsdPerToken(s: string | undefined): number | undefined {
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

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
  return md;
}

/**
 * Pick the canonical pricing for a model from its endpoint list.
 *
 * Strategy: take the *median* prompt and completion across endpoints. The
 * median is what most providers charge, which is the closest signal we have
 * to "real list price."
 *
 * Why not max: the highest endpoint is often a single outlier (e.g. Venice
 * at $1.75 while 11 of 15 providers charge $1.40 for glm-5.1, or Together
 * at $2.10 while 5 of 7 charge $1.74 for deepseek-v4-pro). Max ends up
 * sitting *above* the dominant cluster and prevents the voter from forming
 * a majority with basellm.
 *
 * Why not min: the cheapest endpoint is often a promo (DeepSeek-direct at
 * $0.435/M while everyone else charges $1.74 for the same V4-Pro model).
 * Min directly imports the promo into our canonical.
 *
 * Median picks the dominant cluster without being skewed by single-endpoint
 * outliers in either direction. Provider name returned is the endpoint
 * whose prompt is closest to the median, for the trace.
 */
function pickCanonicalEndpoint(
  endpoints: OpenRouterEndpoint[],
): { promptUsd: number; completionUsd: number; provider: string } | undefined {
  // Collect (prompt, completion, provider) triples for endpoints with valid
  // prices. Carry the per-endpoint pair so completion uses the same row's
  // value when we land on a specific median entry.
  interface Row {
    prompt: number;
    completion: number;
    provider: string;
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
    });
  }
  if (rows.length === 0) return undefined;

  // Median by prompt. With even counts we pick the upper-middle entry rather
  // than averaging — the model's actual price is whichever discrete value
  // dominates, not a synthetic mean that no provider charges.
  rows.sort((a, b) => a.prompt - b.prompt);
  const medianRow = rows[Math.floor(rows.length / 2)]!;
  return {
    promptUsd: medianRow.prompt,
    completionUsd: medianRow.completion,
    provider: medianRow.provider,
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

/**
 * Fetch the OpenRouter model catalog.
 *
 * Two-phase fetch:
 *   1. /v1/models — gets the id list + per-model metadata (context, modality,
 *      supported params, description). Pricing fields here are IGNORED for
 *      canonical resolution because they collapse to the cheapest endpoint
 *      and silently include promo prices.
 *   2. /v1/models/{id}/endpoints (per-model, concurrent) — gets the per-provider
 *      pricing rows. We pick `max(prompt * (1 - discount))` as the canonical
 *      price for each model. Traces are stored module-side for debug logging.
 */
export async function fetchOpenRouterPricingSource(): Promise<PricingSource | null> {
  endpointTraces.clear();

  const summary = await tryFetchJson<{ data?: OpenRouterSummaryModel[] }>(
    OPENROUTER_MODELS_URL,
    { timeoutMs: 15_000 },
  );
  if (!summary?.data || !Array.isArray(summary.data)) {
    consola.warn("[pricing] failed to fetch OpenRouter catalog");
    return null;
  }

  const summaryById = new Map<string, OpenRouterSummaryModel>();
  for (const m of summary.data) {
    if (m.id) summaryById.set(m.id, m);
  }

  const ids = [...summaryById.keys()];
  consola.info(
    `[pricing] OpenRouter fetching /endpoints for ${ids.length} models (concurrency=${ENDPOINTS_CONCURRENCY})`,
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
    `[pricing] OpenRouter /endpoints prefetch: ${withEndpoints}/${ids.length} models with pricing in ${dt}ms`,
  );

  // Build entries from traces (skipping models without endpoints).
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
    `[pricing] OpenRouter loaded ${pricingMap.size} pricing entries, ${metadataMap.size} metadata entries`,
  );

  return {
    name: "openrouter",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(metadataMap),
  };
}
