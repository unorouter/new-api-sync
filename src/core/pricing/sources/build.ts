import type { BaseModelPricing, SourceMetadata } from "./types";

/**
 * Common dual-key indexing for pricing sources.
 *
 * Both LiteLLM and OpenRouter index every entry by both its full upstream key
 * (e.g. `anthropic/claude-opus-4.5`) and its slash-stripped bare suffix
 * (`claude-opus-4.5`), preferring the full key on collision (more specific).
 * This lets the resolver fuzzy-match user-supplied bare names while still
 * catching the rare collision where two providers share a bare name. The
 * slash-stripped form preserves any `:suffix` (e.g. `:free`) because that
 * suffix carries pricing-relevant info — distinct from `toBareName` in
 * bare-name.ts which strips it for catalog identity.
 *
 * basellm has its own loop because it filters by canonical vendor and merges
 * across rows; it does NOT use this helper.
 */
// Above this, an "output cap" is a data artifact rather than a real ceiling: the
// largest single-response limit any vendor publishes is ~128k. Sources mirror the
// context window into the output field when a vendor publishes only one number
// (litellm does it for every xAI entry, ephone reports 2M out on a 500k context),
// and publishing that lets a client request an impossible max_tokens.
const MAX_PLAUSIBLE_OUTPUT_TOKENS = 200_000;

// An output cap is implausible when it exceeds the plausibility ceiling AND is not
// smaller than the context window it belongs to. Below the ceiling a value equal to
// context is genuine (a 4k-context llama really does allow 4k out).
export function isImplausibleOutputCap(
  maxOutput: number | undefined,
  contextWindow: number | undefined,
): boolean {
  if (maxOutput === undefined || maxOutput <= MAX_PLAUSIBLE_OUTPUT_TOKENS)
    return false;
  return contextWindow === undefined || maxOutput >= contextWindow;
}

export function buildPricingMaps<T>(opts: {
  entries: Iterable<[string, T]>;
  toPricing: (key: string, entry: T) => BaseModelPricing | undefined;
  toMetadata: (entry: T) => SourceMetadata;
}): {
  pricingMap: Map<string, BaseModelPricing>;
  metadataMap: Map<string, SourceMetadata>;
} {
  const pricingMap = new Map<string, BaseModelPricing>();
  const metadataMap = new Map<string, SourceMetadata>();

  for (const [key, entry] of opts.entries) {
    const pricing = opts.toPricing(key, entry);
    const metadata = opts.toMetadata(entry);
    const slash = key.lastIndexOf("/");
    const bare = slash >= 0 ? key.slice(slash + 1) : key;

    if (pricing) {
      if (!pricingMap.has(key)) pricingMap.set(key, pricing);
      if (!pricingMap.has(bare)) pricingMap.set(bare, pricing);
    }
    if (Object.keys(metadata).length > 0) {
      if (!metadataMap.has(key)) metadataMap.set(key, metadata);
      if (!metadataMap.has(bare)) metadataMap.set(bare, metadata);
    }
  }

  return { pricingMap, metadataMap };
}
