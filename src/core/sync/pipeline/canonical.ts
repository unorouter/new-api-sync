import type { UpstreamOffer } from "@core/pricing/offers";
import { resolveBasePricing, type PricingSource } from "@core/pricing/resolver";
import type { BaselineInputs } from "@core/pricing/types";
import { consola } from "consola";

/**
 * Build the canonical retail map up front (one lookup per unique exposed
 * model across all offers + baseline). Compute uses this for canonical
 * override and cap-ceiling decisions.
 *
 * Auto-detect "canonical is wrong" outliers: if EVERY upstream offering a
 * model charges far above canonical retail (cheapest upstream_ratio still
 * exceeds canonical × maxRatioCap), then canonical is the outlier — its
 * value would drop the model from every tier despite all upstreams
 * agreeing on a much higher real price. In that case we replace canonical
 * with the cheapest upstream_ratio so the rescale base and cap ceiling
 * both rise proportionally; upstreams pricing this model above 1x land
 * naturally instead of being dropped.
 *
 * This typically catches kimi/deepseek/glm where LiteLLM/OpenRouter/
 * basellm understate market price. Models with only one upstream offer
 * get the same treatment (no consensus to argue against).
 */
export function resolveCanonicalRetail(opts: {
  allOffers: UpstreamOffer[];
  baseline: BaselineInputs;
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
  maxRatioCap: number;
}): Map<string, number> {
  const canonical = new Map<string, number>();
  const seenModels = new Set<string>();
  const upstreamRatiosByModel = new Map<string, number[]>();

  for (const offer of opts.allOffers) {
    for (const m of offer.models) {
      seenModels.add(m.exposed);
      if (m.upstreamRatio !== undefined && m.upstreamRatio > 0) {
        let arr = upstreamRatiosByModel.get(m.exposed);
        if (!arr) {
          arr = [];
          upstreamRatiosByModel.set(m.exposed, arr);
        }
        arr.push(m.upstreamRatio);
      }
    }
  }
  for (const m of opts.baseline.modelRatios.keys()) seenModels.add(m);

  let autoOverrides = 0;
  for (const m of seenModels) {
    const hit = resolveBasePricing(m, opts.pricingSources, opts.reverseMapping);
    const upstreamRatios = upstreamRatiosByModel.get(m);
    if (hit && upstreamRatios && upstreamRatios.length > 0) {
      const cheapestUpstream = Math.min(...upstreamRatios);
      const ceiling = hit.modelRatio * opts.maxRatioCap;
      // Every upstream charges above canonical × cap → canonical is the outlier.
      if (cheapestUpstream > ceiling) {
        canonical.set(m, cheapestUpstream);
        autoOverrides++;
        consola.debug(
          `[pricing] canonical-outlier ${m}: canonical=${hit.modelRatio.toFixed(4)} ` +
            `cheapest_upstream=${cheapestUpstream.toFixed(4)} ` +
            `(>${opts.maxRatioCap}x); using upstream as base`,
        );
        continue;
      }
    }
    if (hit) canonical.set(m, hit.modelRatio);
  }
  if (autoOverrides > 0) {
    consola.info(
      `[pricing] ${autoOverrides} model(s) auto-overrode canonical (every upstream above cap)`,
    );
  }

  return canonical;
}
