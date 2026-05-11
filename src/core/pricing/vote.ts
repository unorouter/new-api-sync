import { lookup } from "@core/catalog/metadata";
import type { PricingSourceName } from "@core/types";
import type { PricingSource } from "./sources/types";

/** Per-source result, serialised into the testing log for debug. */
interface PricingVoteCandidate {
  source: PricingSourceName;
  matchedKey?: string;
  modelRatio?: number;
  completionRatio?: number;
}

interface PricingVoteCluster {
  members: PricingSourceName[];
  modelRatio: number;
  /** Mean across cluster members (sources can disagree on output:input). */
  completionRatio: number;
}

export interface PricingVoteResult {
  candidates: PricingVoteCandidate[];
  /** Largest cluster size ≥ 2, or null. */
  cluster: PricingVoteCluster | null;
  decision: "voted" | "no-majority" | "no-matches";
}

/**
 * Cluster sources by exact modelRatio. No cluster ≥ 2 → no-majority and the
 * caller falls back to whatever new-api has stored, instead of trusting any
 * single source that might be promo-distorted.
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

  // Round to 4 decimals: collapses float artifacts (0.1 vs 0.09999...) without absorbing real disagreement.
  const round = (r: number) => Math.round(r * 10000) / 10000;
  const groups = new Map<number, PricingVoteCandidate[]>();
  for (const c of matched) {
    const r = round(c.modelRatio!);
    const bucket = groups.get(r);
    if (bucket) bucket.push(c);
    else groups.set(r, [c]);
  }

  // Ties: insertion order (first ratio key wins — typically highest-priority source).
  let best: { ratio: number; members: PricingVoteCandidate[] } | undefined;
  for (const [ratio, members] of groups) {
    if (!best || members.length > best.members.length) {
      best = { ratio, members };
    }
  }
  if (!best || best.members.length < 2) {
    return { candidates, cluster: null, decision: "no-majority" };
  }

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
