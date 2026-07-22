import { matchesAnyPattern } from "@core/catalog/constants/patterns";
import type { ProviderConfig } from "@core/validations/config";

export const MAX_ABOVE_1X = 1.05;

/**
 * THE universal priceAdjustment rule. Every path that prices an offer goes
 * through this; cost and ceiling must share a unit (group-ratio space, plain
 * ratio space, or USD).
 *
 * adj > 0: retail sits `adj` of the way from cost to the canonical ceiling
 *   (adj=1 -> exactly 1x). Cap-safe by construction: raising adj approaches
 *   the ceiling, it never crosses it and never drops the lane.
 *   Cost at/above ceiling (no discount to profit on): cost * 1.05, the ONLY
 *   case retail exceeds 1x.
 * adj <= 0: plain multiplier cost * (1 + adj) (yuan convention: the labeled
 *   "USD" cost is really yuan, so selling below it still profits in USD).
 * Unknown ceiling (<= 0): multiplier fallback; the 1x-cap post-pass still guards.
 */
export function applyPriceAdjustment(
  cost: number,
  adj: number,
  ceiling: number,
): number {
  if (adj <= 0 || ceiling <= 0) return cost * (1 + adj);
  if (cost >= ceiling) return cost * MAX_ABOVE_1X;
  return cost + (ceiling - cost) * adj;
}

/** First-match: glob → vendor → modelType → "default". With modelMapping, original (pre-mapping) names also checked. */
export function resolvePriceAdjustment(opts: {
  adj: ProviderConfig["priceAdjustment"];
  model: string;
  vendor: string;
  modelType: string;
  fallback: number;
  modelMapping?: Record<string, string>;
}): number {
  if (opts.adj === undefined) return opts.fallback;
  if (typeof opts.adj === "number") return opts.adj;

  const adj = opts.adj;
  const keys = Object.keys(adj);

  const match = keys.find((k) => matchesAnyPattern(opts.model, [k]));
  if (match) return adj[match]!;

  if (opts.modelMapping) {
    for (const [original, mapped] of Object.entries(opts.modelMapping)) {
      if (mapped === opts.model) {
        const origMatch = keys.find((k) => matchesAnyPattern(original, [k]));
        if (origMatch) return adj[origMatch]!;
      }
    }
  }

  return (
    adj[opts.vendor.toLowerCase()] ??
    adj[opts.modelType] ??
    adj["default"] ??
    opts.fallback
  );
}
