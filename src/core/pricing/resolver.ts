import { type BasellmEntry, lookup } from "@core/catalog/metadata";
import { buildBasellmCanonicalSource } from "./sources/basellm";
import { fetchLiteLLMSource } from "./sources/litellm";
import { fetchOpenRouterPricingSource } from "./sources/openrouter";
import type {
  BaseModelPricing,
  PricingSource,
  SourceMetadata,
} from "./sources/types";

export type { BaseModelPricing, PricingSource, SourceMetadata };

/**
 * Fetch all pricing sources in parallel. Order matters: it sets the priority
 * chain for the resolver — first hit wins.
 *
 * basellm entries are passed in pre-fetched (the pipeline already pulls them
 * for description/tags via fetchBasellmEntries), so we don't double-fetch.
 */
export async function fetchAllPricingSources(
  basellmEntries: BasellmEntry[],
): Promise<PricingSource[]> {
  const [litellm, openrouter] = await Promise.all([
    fetchLiteLLMSource(),
    fetchOpenRouterPricingSource(),
  ]);
  const basellm = buildBasellmCanonicalSource(basellmEntries);

  // Pricing math (canonical resolution, cap drops, pre-test gate) becomes
  // unreliable if any of the three sources is empty — we'd silently fall
  // back to upstream-only ratios with no canonical to compare against.
  // Fail the run loudly so the operator notices and fixes the fetch path.
  const empty: string[] = [];
  if (!litellm || litellm.pricing.candidates.size === 0) empty.push("LiteLLM");
  if (!openrouter || openrouter.pricing.candidates.size === 0)
    empty.push("OpenRouter");
  if (!basellm || basellm.pricing.candidates.size === 0) empty.push("basellm");
  if (empty.length > 0) {
    throw new Error(
      `[pricing] empty pricing sources: ${empty.join(", ")}. ` +
        `Aborting sync — canonical resolution requires all three.`,
    );
  }

  return [litellm, openrouter, basellm].filter(
    (s): s is PricingSource => s != null,
  );
}

/**
 * Resolve base pricing for a model by walking the priority chain. Returns
 * the first source that has a fuzzy match. Reuses lookup() from metadata.ts
 * which handles normalized exact, stripped variants, and reverse-mapping.
 */
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

/**
 * Resolve merged metadata for a model. Walks all sources, layering fields:
 * each field from the highest-priority source that has it wins.
 * Returns the typed SourceMetadata object (no override applied here).
 */
export function resolveSourceMetadata(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): SourceMetadata {
  const merged: SourceMetadata = {};
  // Walk in reverse so higher-priority sources overwrite lower-priority ones
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i]!;
    const hit = lookup(modelName, source.metadata, reverseMapping);
    if (!hit) continue;
    Object.assign(merged, hit.value);
  }
  return merged;
}

/**
 * Build merged metadata for a model. Walks all sources, layering fields:
 * each field from the highest-priority source that has it wins. Override
 * (from enabledModels[].metadata) always wins over source-derived data.
 */
export function buildModelMetadata(opts: {
  modelName: string;
  sources: PricingSource[];
  reverseMapping: Map<string, string>;
  override?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    ...resolveSourceMetadata(opts.modelName, opts.sources, opts.reverseMapping),
  };

  // Override wins
  if (opts.override) {
    for (const [k, v] of Object.entries(opts.override)) {
      if (v !== undefined) merged[k] = v;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Derive feature tags from source metadata. Used to extend basellm-only tags
 * with capabilities that LiteLLM/OpenRouter expose. Output values match the
 * existing tag vocabulary (Reasoning, Tools, Vision, Audio, Files, Open Weights).
 */
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

  // Context-window tag like "128K", "1M"
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
