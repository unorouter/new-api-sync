import { matchesAnyPattern } from "@core/catalog/constants/patterns";
import type { ProviderConfig } from "@core/validations/config";

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
