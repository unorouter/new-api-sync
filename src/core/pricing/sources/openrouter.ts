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
    description: model.description,
    expirationDate: model.expiration_date ?? undefined,
    isModerated: tp?.is_moderated ?? undefined,
    huggingFaceId: model.hugging_face_id ?? undefined,
    supportsCache: model.pricing?.input_cache_read ? true : undefined,
    outputModalities: outputs.length > 0 ? outputs : undefined,
    defaultParameters: dp && Object.keys(dp).length > 0 ? dp : undefined,
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
    const union = new Set<string>(lists.flat());
    const intersection = lists.reduce<Set<string>>(
      (acc, l) => new Set(l.filter((p) => acc.has(p))),
      new Set(lists[0]),
    );
    md.supportedParametersAll = [...union].sort();
    md.supportedParameters = [...intersection].sort();
  }
  if (trace?.picked?.quantization) md.quantization = trace.picked.quantization;
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

function toPricing(
  _key: string,
  model: OpenRouterSummaryModel,
): BaseModelPricing | undefined {
  const picked = endpointTraces.get(model.id)?.picked;
  if (!picked || picked.promptUsd <= 0) return undefined;
  return {
    modelRatio: usdPerTokenToRatio(picked.promptUsd),
    completionRatio:
      picked.completionUsd > 0 ? picked.completionUsd / picked.promptUsd : 1,
    source: "openrouter",
    sourceKey: model.id,
  };
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
  const validEntries: [string, OpenRouterSummaryModel][] = [];
  const failedIds: string[] = [];
  await Promise.all(
    ids.map((id) =>
      limit(async () => {
        const trace = await fetchEndpointsForModel(id);
        if (!trace) {
          failedIds.push(id);
          return;
        }
        endpointTraces.set(id, trace);
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
