import { matchesAnyPattern } from "@core/models/constants";
import type { AnyProviderConfig } from "@core/validations/config";

/**
 * Resolve the priceAdjustment value for a specific model.
 *
 * Lookup order (first match wins):
 * 1. Model name match (any key that glob-matches the model name)
 * 2. Vendor key (e.g. "anthropic", "openai")
 * 3. Model type key (e.g. "image", "video")
 * 4. "default" key
 *
 * When `modelMapping` is provided, both the mapped name and any original
 * (pre-mapping) name are checked against model-name keys.
 */
export function resolvePriceAdjustment(opts: {
  adj: AnyProviderConfig["priceAdjustment"];
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

  // 1. Try every key as a glob pattern against the model name
  const match = keys.find((k) => matchesAnyPattern(opts.model, [k]));
  if (match) return adj[match]!;

  // Also check original (pre-mapping) names
  if (opts.modelMapping) {
    for (const [original, mapped] of Object.entries(opts.modelMapping)) {
      if (mapped === opts.model) {
        const origMatch = keys.find((k) => matchesAnyPattern(original, [k]));
        if (origMatch) return adj[origMatch]!;
      }
    }
  }

  // 2. Vendor key
  const vendorVal = adj[opts.vendor.toLowerCase()];
  if (vendorVal !== undefined) return vendorVal;

  // 3. Model type key
  const typeVal = adj[opts.modelType];
  if (typeVal !== undefined) return typeVal;

  // 4. Default
  return adj["default"] ?? opts.fallback;
}
