import { lookup } from "@core/catalog/metadata";
import type { PricingSourceName } from "@core/types";
import type { BaseModelPricing, PricingSource } from "./sources/types";

/**
 * Per-source result for one model lookup, suitable for serializing into a
 * testing log so operators can see exactly why the voted canonical landed
 * where it did (or didn't).
 */
export interface PricingVoteCandidate {
  source: PricingSourceName;
  matchedKey?: string;
  modelRatio?: number;
  completionRatio?: number;
}

export interface PricingVoteCluster {
  /** Sources that voted for this exact (bit-equal) modelRatio. */
  members: PricingSourceName[];
  modelRatio: number;
  /** Mean completionRatio across cluster members (sources can disagree on output:input). */
  completionRatio: number;
}

export interface PricingVoteResult {
  candidates: PricingVoteCandidate[];
  /** Largest cluster with size >= 2, or null when no majority emerged. */
  cluster: PricingVoteCluster | null;
  decision: "voted" | "no-majority" | "no-matches";
}

/**
 * Resolve canonical pricing for a model by polling every source and clustering
 * exact matches on `modelRatio`.
 *
 * Algorithm:
 *   1. Fuzzy-lookup `modelName` in each source via the existing `lookup()`
 *      chain (so reverse-mapped names + stripped variants still resolve).
 *   2. Group hits by exact (bit-equal) `modelRatio`.
 *   3. Pick the largest group with size >= 2 — that's the "voted" canonical.
 *   4. On no group >= 2, return decision=no-majority and cluster=null. The
 *      caller then falls back to whatever new-api already has stored, instead
 *      of trusting any single source that might be promo-distorted.
 *
 * Why exact and not tolerance-based: rounding rarely diverges across sources
 * for the same listed price (they all do `usd_per_M / 2`), but promo prices
 * diverge by 4x or more. Exact equality cleanly separates "rounding noise"
 * (which is rarely an issue in practice) from "promo distortion" (which is
 * the whole reason this voter exists).
 */
export function resolveCanonicalByVote(
  modelName: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
): PricingVoteResult {
  const candidates: PricingVoteCandidate[] = [];

  for (const source of sources) {
    const hit = lookup(modelName, source.pricing, reverseMapping);
    if (hit) {
      candidates.push({
        source: source.name,
        matchedKey: hit.key,
        modelRatio: hit.value.modelRatio,
        completionRatio: hit.value.completionRatio,
      });
    } else {
      candidates.push({ source: source.name });
    }
  }

  const matched = candidates.filter(
    (c): c is PricingVoteCandidate & { modelRatio: number } =>
      c.modelRatio !== undefined,
  );
  if (matched.length === 0) {
    return { candidates, cluster: null, decision: "no-matches" };
  }

  // Group by exact modelRatio (bit-equal). Map<ratioKey, candidates>.
  const groups = new Map<number, PricingVoteCandidate[]>();
  for (const c of matched) {
    const r = c.modelRatio!;
    const bucket = groups.get(r);
    if (bucket) bucket.push(c);
    else groups.set(r, [c]);
  }

  // Pick the largest group; tie-break by sum of completionRatio agreement.
  let best:
    | { ratio: number; members: PricingVoteCandidate[] }
    | undefined;
  for (const [ratio, members] of groups) {
    if (!best || members.length > best.members.length) {
      best = { ratio, members };
    }
  }
  if (!best || best.members.length < 2) {
    return { candidates, cluster: null, decision: "no-majority" };
  }

  // Cluster completionRatio = mean across members (typically all the same).
  const completionRatios = best.members
    .map((m) => m.completionRatio)
    .filter((x): x is number => x !== undefined);
  const completionRatio =
    completionRatios.length > 0
      ? completionRatios.reduce((a, b) => a + b, 0) / completionRatios.length
      : 1;

  return {
    candidates,
    cluster: {
      members: best.members.map((m) => m.source),
      modelRatio: best.ratio,
      completionRatio,
    },
    decision: "voted",
  };
}

/**
 * Pre-test gate predictor that mirrors the post-test cap math in
 * `processStandardOffer` but uses the *voted* canonical.
 *
 * Returns a drop reason when the predicted customer charge would exceed the
 * canonical-times-cap ceiling, or undefined when it's safe to test.
 *
 * When the voter returns no-majority/no-matches we return undefined too —
 * better to spend the test request than to drop based on a single possibly-
 * promo'd source.
 */
export interface PredictAboveCanonicalArgs {
  upstreamRatio: number;
  groupRatio: number;
  adjustment: number;
  cap: number;
  vote: PricingVoteResult;
}

export interface PredictedAboveCanonical {
  charge: number;
  ceiling: number;
  canonicalRatio: number;
  effectiveRatio: number;
}

export function predictAboveCanonical(
  args: PredictAboveCanonicalArgs,
): PredictedAboveCanonical | undefined {
  const canonical = args.vote.cluster?.modelRatio;
  if (canonical === undefined) return undefined;

  // Mirrors processStandardOffer's math:
  //     writtenRatio = canonical ?? upstreamRatio
  //     rescale      = upstreamRatio / writtenRatio
  //     effective    = groupRatio * (1 + adjustment) * rescale
  //     charge       = writtenRatio * effective
  //     ceiling      = canonical * cap
  const writtenRatio = canonical;
  const rescale =
    writtenRatio > 0 ? args.upstreamRatio / writtenRatio : 1;
  const effective = args.groupRatio * (1 + args.adjustment) * rescale;
  const charge = writtenRatio * effective;
  const ceiling = canonical * args.cap;

  if (charge <= ceiling) return undefined;
  return {
    charge,
    ceiling,
    canonicalRatio: canonical,
    effectiveRatio: effective,
  };
}
