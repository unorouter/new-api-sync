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
