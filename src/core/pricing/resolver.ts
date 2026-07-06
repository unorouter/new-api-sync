import { toBareName } from "@core/catalog/bare-name";
import { type BasellmEntry, lookup } from "@core/catalog/metadata";
import { t } from "@server/i18n";
import { fetchAipricingSource } from "./sources/aipricing";
import { buildBasellmCanonicalSource } from "./sources/basellm";
import { buildCuratedSource, CURATED_OVERRIDE } from "./sources/curated";
import { fetchEphoneMetadataSource } from "./sources/ephone";
import { fetchGenaiPricesSource } from "./sources/genai-prices";
import { fetchLiteLLMSource } from "./sources/litellm";
import { fetchLlmPricesSource } from "./sources/llm-prices";
import { fetchModelsDevSource } from "./sources/models-dev";
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
  const [
    llmPrices,
    litellm,
    openrouter,
    modelsDev,
    aipricing,
    genaiPrices,
    ephone,
  ] = await Promise.all([
    fetchLlmPricesSource(),
    fetchLiteLLMSource(),
    fetchOpenRouterPricingSource(),
    fetchModelsDevSource(),
    fetchAipricingSource(),
    fetchGenaiPricesSource(),
    fetchEphoneMetadataSource(),
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

  return [
    llmPrices,
    basellm,
    litellm,
    openrouter,
    modelsDev,
    aipricing,
    genaiPrices,
    // ePhone metadata (description/release/cutoff/context/tags) fills gaps the
    // pricing-focused live sources leave blank, esp. Chinese-vendor video/audio
    // + fresh flagships. Array order = priority (earlier wins via the reverse
    // Object.assign in resolveOneName), so ePhone outranks curated: ePhone ships
    // real catalog dates for models curated only hand-guessed.
    ephone,
    // last = lowest priority: only fills gaps every other source left blank
    buildCuratedSource(),
  ].filter((s): s is PricingSource => s != null);
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

function resolveOneName(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): SourceMetadata {
  const merged: SourceMetadata = {};
  for (let i = sources.length - 1; i >= 0; i--) {
    const hit = lookup(modelName, sources[i]!.metadata, reverseMapping);
    if (hit) Object.assign(merged, hit.value);
  }
  // Corrections that win over every live source (verified known-wrong upstreams).
  const override = CURATED_OVERRIDE[modelName];
  if (override) Object.assign(merged, override);
  return merged;
}

// DashScope/relay task-endpoint suffixes (kling-3.0-turbo/image-to-video,
// viduq3-pro/text-to-video, eleven_flash_v2_5/text-to-speech). These publish with
// the suffix intact (bare-name collision keeps the full id), but the task word
// carries no metadata - resolve the base model identity instead. Stripped BEFORE
// toBareName so the base survives (toBareName would keep only the task word).
const TASK_SUFFIX =
  /\/(?:image|text|start-end|video|audio|speech)-to-(?:video|image|speech|text|audio)$/;

export function resolveSourceMetadata(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): SourceMetadata {
  const detasked = modelName.replace(TASK_SUFFIX, "");
  // A `{model}:free` published name has no metadata key of its own; fuzzy-matching
  // the literal `:free` lands on a wrong dateless candidate, so resolve the bare
  // identity (real date/description). The suffix carries no unique metadata.
  const bare = toBareName(detasked);
  return resolveOneName(
    bare === modelName ? modelName : bare,
    sources,
    reverseMapping,
  );
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
  // prettier-ignore
  const flags: Array<[keyof SourceMetadata, string]> = [["isReasoning","Reasoning"],["supportsTools","Tools"],["supportsVision","Vision"],["supportsAudio","Audio"],["supportsVideo","Video"],["supportsPdf","Files"],["supportsCache","Cache"],["supportsWebSearch","WebSearch"],["supportsComputerUse","ComputerUse"]];
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
