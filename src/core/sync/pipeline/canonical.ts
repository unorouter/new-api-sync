import type { UpstreamOffer } from "@core/pricing/offers";
import { resolveBasePricing, type PricingSource } from "@core/pricing/resolver";
import type { BaselineInputs } from "@core/pricing/types";

/**
 * Build the canonical retail map up front (one lookup per unique exposed
 * model across all offers + baseline). Compute uses this for canonical
 * override and the 1x ceiling.
 *
 * Voting (resolveCanonicalByVote) is the source of truth used by the
 * pre-test gate. resolveBasePricing here returns the priority-chain first
 * hit, which is good enough for the post-test compute pass — if compute's
 * canonical disagrees with the voted one, the cap-exceeded drop list catches
 * the gap and the operator can audit via the testing log.
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
    const hit = resolveBasePricing(m, opts.pricingSources, opts.reverseMapping);
    if (hit) canonical.set(m, hit.modelRatio);
  }

  return canonical;
}
