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
// Internal "cards" endpoint: the only source of `group` (series) + category
// usage. The public /api/v1/models omits both.
const OPENROUTER_CARDS_URL =
  "https://openrouter.ai/api/frontend/v1/models/find?active=true&fmt=cards";
const ENDPOINTS_CONCURRENCY = 20;

// slug -> { series, categories } from the cards endpoint, keyed by bare model id.
const cardsMeta = new Map<string, { series?: string; categories?: string[] }>();

interface OpenRouterCardModel {
  slug?: string;
  permaslug?: string;
  group?: string | null;
}
interface OpenRouterCardCategoryRow {
  category?: string;
}

async function fetchCardsMeta(): Promise<void> {
  cardsMeta.clear();
  const raw = await tryFetchJson<{
    data?: {
      models?: OpenRouterCardModel[];
      categories?: Record<string, OpenRouterCardCategoryRow[]>;
    };
  }>(OPENROUTER_CARDS_URL, { timeoutMs: 15_000 });
  const data = raw?.data;
  if (!data?.models) return;
  // Top categories per model permaslug (volume-ordered as returned).
  const catBySlug = new Map<string, string[]>();
  for (const [slug, rows] of Object.entries(data.categories ?? {})) {
    const cats = [
      ...new Set(
        (rows ?? [])
          .map((r) => r.category?.split("/")[0])
          .filter((c): c is string => Boolean(c)),
      ),
    ];
    if (cats.length) catBySlug.set(slug, cats);
  }
  const bare = (id: string) => {
    const i = id.indexOf("/");
    return i >= 0 ? id.slice(i + 1) : id;
  };
  for (const m of data.models) {
    const keys = [m.slug, m.permaslug].filter((k): k is string => Boolean(k));
    const entry = {
      series: m.group ?? undefined,
      categories: m.permaslug ? catBySlug.get(m.permaslug) : undefined,
    };
    for (const k of keys) {
      cardsMeta.set(k, entry);
      cardsMeta.set(bare(k), entry);
    }
  }
}

interface OpenRouterSummaryModel {
  id: string;
  description?: string;
  context_length?: number;
  created?: number;
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
  hugging_face_id?: string | null;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
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

export const getOpenRouterEndpointsTrace = (
  id: string,
): OpenRouterEndpointsTrace | undefined => endpointTraces.get(id);

const parseUsdPerToken = (s: string | undefined): number | undefined => {
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function assign<T extends object>(target: T, patch: Partial<T>): void {
  for (const k in patch) {
    const v = patch[k];
    if (v !== undefined) target[k] = v as T[Extract<keyof T, string>];
  }
}

function toMetadata(model: OpenRouterSummaryModel): SourceMetadata {
  const md: SourceMetadata = {};
  const tp = model.top_provider;
  const arch = model.architecture;
  const dp = model.default_parameters;
  const ctx = tp?.context_length ?? model.context_length;
  const params = model.supported_parameters ?? [];
  const inputs = arch?.input_modalities ?? [];
  const outputs = arch?.output_modalities ?? [];
  const has = (p: string) => params.includes(p);

  assign(md, {
    maxInputTokens: ctx ?? undefined,
    contextWindow: ctx ?? undefined,
    maxOutputTokens: tp?.max_completion_tokens ?? undefined,
    tokenizer: arch?.tokenizer,
    knowledgeCutoff: model.knowledge_cutoff ?? undefined,
    releaseDate: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
    description: model.description,
    expirationDate: model.expiration_date ?? undefined,
    isModerated: tp?.is_moderated ?? undefined,
    huggingFaceId: model.hugging_face_id ?? undefined,
    supportsCache: model.pricing?.input_cache_read ? true : undefined,
    outputModalities: outputs.length > 0 ? outputs : undefined,
    defaultParameters: dp && Object.keys(dp).length > 0 ? dp : undefined,
    series: cardsMeta.get(model.id)?.series,
    categories: cardsMeta.get(model.id)?.categories,
  });
  if (params.length > 0) {
    md.supportsTools = has("tools");
    md.supportsParallelTools = has("parallel_tool_calls");
    md.isReasoning = has("reasoning") || has("include_reasoning");
    md.supportsResponseFormat =
      has("response_format") || has("structured_outputs");
    md.supportsWebSearch = has("web_search_options");
  }
  if (inputs.length > 0) {
    md.inputModalities = inputs;
    md.supportsVision = inputs.includes("image");
    md.supportsAudio = inputs.includes("audio");
    md.supportsVideo = inputs.includes("video");
    md.supportsPdf = inputs.includes("file");
  }

  const trace = endpointTraces.get(model.id);
  const lists =
    trace?.endpoints
      ?.map((e) => e.supportedParameters)
      .filter((l): l is string[] => Array.isArray(l) && l.length > 0) ?? [];
  if (lists.length > 0) {
    // Hosts of one model disagree (GMICloud takes no penalties where DeepSeek's own
    // endpoint does), so neither extreme describes the model: a strict intersection
    // lets ONE outlier delete a param 14 other hosts accept, and the union promises
    // support most routes cannot honor. Publish what a MAJORITY serves, which is what
    // an unpinned request actually lands on, and keep the union as expert mode.
    const counts = new Map<string, number>();
    for (const p of lists.flat()) counts.set(p, (counts.get(p) ?? 0) + 1);
    const quorum = Math.ceil(lists.length / 2);
    md.supportedParametersAll = [...counts.keys()].sort();
    md.supportedParameters = [...counts.entries()]
      .filter(([, n]) => n >= quorum)
      .map(([p]) => p)
      .sort();
    md.supportedParametersByHost = Object.fromEntries(
      trace?.endpoints
        ?.filter((e) => Array.isArray(e.supportedParameters))
        .map((e) => [e.provider, [...e.supportedParameters!].sort()]) ?? [],
    );
  }
  if (trace?.picked?.quantization) md.quantization = trace.picked.quantization;
  // No endpoint trace: the summary list is ONE provider's view, so it cannot claim to
  // be the cross-host answer. Record it as the union only, leaving supportedParameters
  // absent rather than asserting an intersection we never computed.
  if (!md.supportedParameters && params.length > 0) {
    md.supportedParametersAll = [...params].sort();
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

function toPricing(
  _key: string,
  model: OpenRouterSummaryModel,
): BaseModelPricing | undefined {
  const picked = endpointTraces.get(model.id)?.picked;
  if (picked && picked.promptUsd > 0) {
    return {
      modelRatio: usdPerTokenToRatio(picked.promptUsd),
      completionRatio:
        picked.completionUsd > 0 ? picked.completionUsd / picked.promptUsd : 1,
      source: "openrouter",
      sourceKey: model.id,
    };
  }
  // Fallback to the summary list price when the per-model /endpoints fetch
  // returned nothing (common for brand-new models whose endpoints lag the
  // catalog). Without this the model contributes no vote, so a model only one
  // other source prices fails to cluster and ships free.
  const promptUsd = parseUsdPerToken(model.pricing?.prompt);
  if (promptUsd == null || promptUsd <= 0) return undefined;
  const completionUsd =
    parseUsdPerToken(model.pricing?.completion) ?? promptUsd;
  return {
    modelRatio: usdPerTokenToRatio(promptUsd),
    completionRatio: completionUsd > 0 ? completionUsd / promptUsd : 1,
    source: "openrouter",
    sourceKey: model.id,
  };
}

export async function fetchOpenRouterPricingSource(): Promise<PricingSource | null> {
  endpointTraces.clear();
  // Series + categories live only in the cards endpoint; best-effort (failure
  // just leaves those metadata fields undefined).
  const [summary] = await Promise.all([
    tryFetchJson<{ data?: OpenRouterSummaryModel[] }>(OPENROUTER_MODELS_URL, {
      timeoutMs: 15_000,
    }),
    fetchCardsMeta(),
  ]);
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
  const validEntries: [string, OpenRouterSummaryModel][] = [];
  const failedIds: string[] = [];
  await Promise.all(
    ids.map((id) =>
      limit(async () => {
        const trace = await fetchEndpointsForModel(id);
        if (trace) endpointTraces.set(id, trace);
        else failedIds.push(id);
        // Kept regardless of the trace: modality, context and capability flags
        // are properties of the MODEL and live in the summary, so tying them to
        // a priced endpoint dropped every free model's metadata. fetchEndpoints
        // returns null for a model whose endpoints all price at 0, which is
        // exactly what a free model looks like. toMetadata already treats the
        // trace as optional and falls back to the summary's own fields.
        const model = summaryById.get(id);
        if (model) validEntries.push([id, model]);
      }),
    ),
  );
  if (failedIds.length > 0) {
    // Surface which models dropped: "no endpoints" vs "fetch failed" are otherwise indistinguishable.
    const shown = failedIds.slice(0, 15);
    const more =
      failedIds.length > 15 ? ` (+${failedIds.length - 15} more)` : "";
    consola.warn(
      `OpenRouter endpoint prefetch failed for ${failedIds.length}/${ids.length}: ${shown.join(", ")}${more}`,
    );
  }
  consola.info(
    t("CORE.PRICING.OPENROUTER_PREFETCH_DONE", {
      with: validEntries.length,
      total: ids.length,
      dt: Math.round(performance.now() - t0),
    }),
  );

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
