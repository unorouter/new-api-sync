import { matchesAnyPattern, parseModelList } from "@/lib/constants";
import type { SyncState } from "@/lib/types";
import type { AnyProviderConfig } from "@/config";
import { consola } from "consola";

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

  // 1. Try every key as a glob pattern against the model name
  const keys = Object.keys(adj);
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

/**
 * Build price tiers by grouping models by their adjusted ratio.
 * For each model, finds the cheapest existing group ratio from other providers,
 * then applies the per-model adjustment to get the final ratio.
 */
export function buildPriceTiers(opts: {
  models: string[];
  adj: AnyProviderConfig["priceAdjustment"];
  defaultAdjustment: number;
  vendor: string;
  state: SyncState;
  excludeProvider: string;
  modelMapping?: Record<string, string>;
}): Map<number, string[]> {
  const groupRatioByName = new Map(
    opts.state.mergedGroups.map((g) => [g.name, g.ratio]),
  );
  const cheapestGroupForModel = new Map<string, number>();
  for (const ch of opts.state.channelsToCreate) {
    if (ch.tag === opts.excludeProvider) continue;
    const gRatio = groupRatioByName.get(ch.group) ?? 1;
    for (const model of parseModelList(ch.models)) {
      const existing = cheapestGroupForModel.get(model);
      if (existing === undefined || gRatio < existing) {
        cheapestGroupForModel.set(model, gRatio);
      }
    }
  }

  consola.debug(
    `[buildPriceTiers] ${opts.models.length} models, ${opts.state.channelsToCreate.length} baseline channels, ` +
      `${opts.state.mergedGroups.length} groups, excluding="${opts.excludeProvider}"`,
  );

  const ratioToModels = new Map<number, string[]>();
  for (const model of opts.models) {
    const cheapest = cheapestGroupForModel.get(model) ?? 1;
    const adjustment = resolvePriceAdjustment({
      adj: opts.adj,
      model,
      vendor: opts.vendor,
      modelType: "text",
      fallback: opts.defaultAdjustment,
      modelMapping: opts.modelMapping,
    });
    const ratio = cheapest * (1 + adjustment);
    consola.debug(
      `[buildPriceTiers]   ${model}: cheapest=${cheapest.toFixed(4)} × (1+${adjustment}) = ${ratio.toFixed(6)}`,
    );
    const key = Math.round(ratio * 1e6) / 1e6;
    if (!ratioToModels.has(key)) ratioToModels.set(key, []);
    ratioToModels.get(key)!.push(model);
  }
  return ratioToModels;
}

/**
 * Push tiered channels and groups into SyncState from a ratio→models map.
 */
export function pushTieredChannels(
  ratioToModels: Map<number, string[]>,
  baseName: string,
  opts: {
    type: number;
    key: string;
    baseUrl: string;
    provider: string;
    description: string;
  },
  state: SyncState,
): void {
  const sortedTiers = [...ratioToModels.entries()].sort(([a], [b]) => a - b);
  let tierIdx = 0;
  for (const [groupRatio, models] of sortedTiers) {
    const suffix = ratioToModels.size > 1 ? `-t${tierIdx}` : "";
    const tierName = `${baseName}${suffix}`;

    state.mergedGroups.push({
      name: tierName,
      ratio: groupRatio,
      description: opts.description,
      provider: opts.provider,
    });

    state.channelsToCreate.push({
      name: tierName,
      type: opts.type,
      key: opts.key,
      base_url: opts.baseUrl.replace(/\/$/, ""),
      models: models.join(","),
      group: tierName,
      priority: 0,
      weight: 1,
      status: 1,
      tag: opts.provider,
      remark: tierName,
    });

    tierIdx++;
  }
}
