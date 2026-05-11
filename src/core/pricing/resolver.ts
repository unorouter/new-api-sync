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

export function resolveSourceMetadata(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): SourceMetadata {
  const merged: SourceMetadata = {};
  for (let i = sources.length - 1; i >= 0; i--) {
    const hit = lookup(modelName, sources[i]!.metadata, reverseMapping);
    if (hit) Object.assign(merged, hit.value);
  }
  return merged;
}

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
    for (const [k, v] of Object.entries(opts.override))
      if (v !== undefined) merged[k] = v;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function deriveTagsFromMetadata(md: SourceMetadata): string[] {
  const tags: string[] = [];
  const flags: Array<[keyof SourceMetadata, string]> = [
    ["isReasoning", "Reasoning"],
    ["supportsTools", "Tools"],
    ["supportsVision", "Vision"],
    ["supportsAudio", "Audio"],
    ["supportsVideo", "Video"],
    ["supportsPdf", "Files"],
    ["supportsCache", "Cache"],
    ["supportsWebSearch", "WebSearch"],
    ["supportsComputerUse", "ComputerUse"],
  ];
  for (const [key, label] of flags) if (md[key]) tags.push(label);

  const ctx = md.contextWindow ?? md.maxInputTokens;
  if (ctx != null && ctx > 0) {
    const fmt = (n: number, unit: string) =>
      `${n === Math.floor(n) ? n : n.toFixed(1)}${unit}`;
    if (ctx >= 1_000_000) tags.push(fmt(ctx / 1_000_000, "M"));
    else if (ctx >= 1000) tags.push(fmt(ctx / 1000, "K"));
    else tags.push(`${ctx}`);
  }
  return tags;
}
