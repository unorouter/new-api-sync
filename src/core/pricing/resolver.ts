import { type BasellmEntry, lookup } from "@core/catalog/metadata";
import { t } from "@server/i18n";
import { buildBasellmCanonicalSource } from "./sources/basellm";
import { fetchLiteLLMSource } from "./sources/litellm";
import { fetchLlmPricesSource } from "./sources/llm-prices";
import { fetchOpenRouterPricingSource } from "./sources/openrouter";
import type {
  BaseModelPricing,
  PricingSource,
  SourceMetadata,
} from "./sources/types";

export type { BaseModelPricing, PricingSource, SourceMetadata };

/**
 * Priority chain for resolveBasePricing (first hit wins):
 *   1. llm-prices (advisory; OK to fail)  2. basellm (canonical, vendor-filtered)
 *   3. LiteLLM  4. OpenRouter
 * Empty 2/3/4 throws — fetch regression should fail loud.
 */
export async function fetchAllPricingSources(
  basellmEntries: BasellmEntry[],
): Promise<PricingSource[]> {
  const [llmPrices, litellm, openrouter] = await Promise.all([
    fetchLlmPricesSource(),
    fetchLiteLLMSource(),
    fetchOpenRouterPricingSource(),
  ]);
  const basellm = buildBasellmCanonicalSource(basellmEntries);

  const empty: string[] = [];
  if (!litellm || litellm.pricing.candidates.size === 0) empty.push("LiteLLM");
  if (!openrouter || openrouter.pricing.candidates.size === 0)
    empty.push("OpenRouter");
  if (!basellm || basellm.pricing.candidates.size === 0) empty.push("basellm");
  if (empty.length > 0) {
    throw new Error(
      t("ERROR.PRICING_EMPTY_SOURCES", { sources: empty.join(", ") }),
    );
  }

  return [llmPrices, basellm, litellm, openrouter].filter(
    (s): s is PricingSource => s != null,
  );
}

/** First fuzzy match in priority order. */
export function resolveBasePricing(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): BaseModelPricing | undefined {
  for (const source of sources) {
    const hit = lookup(modelName, source.pricing, reverseMapping);
    if (hit) return hit.value;
  }
  return undefined;
}

/** Merge fields across sources; higher-priority wins (walked in reverse so higher overwrites later). */
export function resolveSourceMetadata(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): SourceMetadata {
  const merged: SourceMetadata = {};
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]!;
    const hit = lookup(modelName, source.metadata, reverseMapping);
    if (!hit) continue;
    Object.assign(merged, hit.value);
  }
  return merged;
}

/** Override (from enabledModels[].metadata) wins over source-derived. */
export function buildModelMetadata(opts: {
  modelName: string;
  sources: PricingSource[];
  reverseMapping: Map<string, string>;
  override?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    ...resolveSourceMetadata(opts.modelName, opts.sources, opts.reverseMapping),
  };

  if (opts.override) {
    for (const [k, v] of Object.entries(opts.override)) {
      if (v !== undefined) merged[k] = v;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Tag vocab: Reasoning, Tools, Vision, Audio, Files, Cache, WebSearch, ComputerUse, <N>K|M. */
export function deriveTagsFromMetadata(md: SourceMetadata): string[] {
  const tags: string[] = [];
  if (md.isReasoning) tags.push("Reasoning");
  if (md.supportsTools) tags.push("Tools");
  if (md.supportsVision) tags.push("Vision");
  if (md.supportsAudio) tags.push("Audio");
  if (md.supportsVideo) tags.push("Video");
  if (md.supportsPdf) tags.push("Files");
  if (md.supportsCache) tags.push("Cache");
  if (md.supportsWebSearch) tags.push("WebSearch");
  if (md.supportsComputerUse) tags.push("ComputerUse");

  const ctx = md.contextWindow ?? md.maxInputTokens;
  if (ctx != null && ctx > 0) {
    if (ctx >= 1_000_000) {
      const m = ctx / 1_000_000;
      tags.push(m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`);
    } else if (ctx >= 1000) {
      const k = ctx / 1000;
      tags.push(k === Math.floor(k) ? `${k}K` : `${k.toFixed(1)}K`);
    } else {
      tags.push(`${ctx}`);
    }
  }
  return tags;
}
