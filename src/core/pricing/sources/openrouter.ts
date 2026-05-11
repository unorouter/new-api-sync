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
const ENDPOINTS_CONCURRENCY = 20;

interface OpenRouterSummaryModel {
  id: string;
  description?: string;
  context_length?: number;
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
  hugging_face_id?: string | null;
  pricing?: { input_cache_read?: string };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  default_parameters?: Record<string, number | null>;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
}

interface OpenRouterEndpoint {
  provider_name: string;
  quantization?: string;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string; discount?: number };
}

interface TraceRow {
  provider: string;
  quantization?: string;
  supportedParameters?: string[];
  prompt: number;
  completion: number;
  discount: number;
  effectivePrompt: number;
  effectiveCompletion: number;
}

export interface OpenRouterEndpointsTrace {
  id: string;
  endpoints: TraceRow[];
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
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function toMetadata(model: OpenRouterSummaryModel): SourceMetadata {
  const md: SourceMetadata = {};
  const tp = model.top_provider;
  const arch = model.architecture;
  const dp = model.default_parameters;
  const ctx = tp?.context_length ?? model.context_length;
  if (ctx != null) {
    md.maxInputTokens = ctx;
    md.contextWindow = ctx;
  }
  if (tp?.max_completion_tokens != null)
    md.maxOutputTokens = tp.max_completion_tokens;
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
  const inputs = arch?.input_modalities ?? [];
  const outputs = arch?.output_modalities ?? [];
  if (inputs.length > 0) {
    md.inputModalities = inputs;
    md.supportsVision = inputs.includes("image");
    md.supportsAudio = inputs.includes("audio");
    md.supportsVideo = inputs.includes("video");
    md.supportsPdf = inputs.includes("file");
  }
  if (outputs.length > 0) md.outputModalities = outputs;
  if (arch?.tokenizer) md.tokenizer = arch.tokenizer;
  if (model.pricing?.input_cache_read) md.supportsCache = true;
  if (model.knowledge_cutoff) md.knowledgeCutoff = model.knowledge_cutoff;
  if (model.description) md.description = model.description;
  if (model.expiration_date) md.expirationDate = model.expiration_date;
  if (tp?.is_moderated != null) md.isModerated = tp.is_moderated;
  if (model.hugging_face_id) md.huggingFaceId = model.hugging_face_id;
  if (dp && Object.keys(dp).length > 0) md.defaultParameters = dp;

  const trace = endpointTraces.get(model.id);
  if (trace?.endpoints?.length) {
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
    if (trace.picked?.quantization) md.quantization = trace.picked.quantization;
  }
  if (!md.supportedParameters && params.length > 0) {
    md.supportedParameters = [...params].sort();
    md.supportedParametersAll = md.supportedParameters;
  }
  return md;
}

async function fetchEndpointsForModel(
  id: string,
): Promise<OpenRouterEndpointsTrace | null> {
  const raw = await tryFetchJson<{
    data?: { id: string; endpoints?: OpenRouterEndpoint[] };
  }>(OPENROUTER_ENDPOINTS_URL(id), { timeoutMs: 10_000 });
  if (!raw?.data?.endpoints?.length) return null;

  const trace: OpenRouterEndpointsTrace = { id, endpoints: [] };
  for (const ep of raw.data.endpoints) {
    const prompt = parseUsdPerToken(ep.pricing?.prompt);
    if (prompt == null || prompt <= 0) continue;
    const completion = parseUsdPerToken(ep.pricing?.completion) ?? prompt;
    const discount = ep.pricing?.discount ?? 0;
    trace.endpoints.push({
      provider: ep.provider_name,
      quantization: ep.quantization,
      supportedParameters: ep.supported_parameters,
      prompt,
      completion,
      discount,
      effectivePrompt: prompt * (1 - discount),
      effectiveCompletion: completion * (1 - discount),
    });
  }
  if (trace.endpoints.length === 0) return null;
  const sorted = [...trace.endpoints].sort(
    (a, b) => a.effectivePrompt - b.effectivePrompt,
  );
  const m = sorted[Math.floor(sorted.length / 2)]!;
  trace.picked = {
    provider: m.provider,
    promptUsd: m.effectivePrompt,
    completionUsd: m.effectiveCompletion,
    quantization: m.quantization,
  };
  return trace;
}

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
  for (const m of summary.data) if (m.id) summaryById.set(m.id, m);

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
    const trace = results[i];
    if (trace) {
      endpointTraces.set(ids[i]!, trace);
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
    if (endpointTraces.has(id)) validEntries.push([id, model]);
  }

  const toPricing = (
    _key: string,
    model: OpenRouterSummaryModel,
  ): BaseModelPricing | undefined => {
    const picked = endpointTraces.get(model.id)?.picked;
    if (!picked || picked.promptUsd <= 0) return undefined;
    return {
      modelRatio: usdPerTokenToRatio(picked.promptUsd),
      completionRatio:
        picked.completionUsd > 0 ? picked.completionUsd / picked.promptUsd : 1,
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
