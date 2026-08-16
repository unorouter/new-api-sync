import type { UpstreamOffer } from "@core/pricing/offers";
import type { PricingSource } from "@core/pricing/sources/types";
import type { BaselineInputs } from "@core/pricing/types";
import { resolveCanonicalByVote } from "@core/pricing/vote";

/**
 * Build the canonical retail map up front (one lookup per unique exposed
 * model across all offers + baseline). Compute uses this for the strikethrough
 * "original price" surfaced in the new-api UI and for written-ratio rescaling.
 *
 * Uses the voter (not priority-chain first-hit) so models where sources
 * disagree by more than rounding noise get NO canonical entry rather than a
 * wrong one. Concretely: glm-5.1 has basellm=3 ($6/M, Zhipu's published list)
 * vs OpenRouter=0.875 ($1.75/M, what every reseller actually charges) — no
 * cluster forms, so we don't write a value, and the UI shows the live price
 * with no strikethrough instead of an inflated $6 origin.
 */
export function resolveCanonicalRetail(opts: {
  allOffers: UpstreamOffer[];
  baseline: BaselineInputs;
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
}): Map<string, number> {
  const canonical = new Map<string, number>();
  const seenModels = new Set<string>();

  for (const offer of opts.allOffers) {
    for (const m of offer.models) seenModels.add(m.exposed);
  }
  for (const m of opts.baseline.modelRatios.keys()) seenModels.add(m);

  for (const m of seenModels) {
    const vote = resolveCanonicalByVote(
      m,
      opts.pricingSources,
      opts.reverseMapping,
    );
    if (vote.cluster) canonical.set(m, vote.cluster.modelRatio);
  }

  return canonical;
}
