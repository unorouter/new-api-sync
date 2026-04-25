import { inferVendorFromModelName } from "@core/models/constants";
import type { AnyProviderConfig } from "@core/validations/config";
import { buildPriceTiers, pushTieredChannels } from "@core/pricing";
import type { SyncState } from "@core/types";

/**
 * Group exposed model names by vendor (via inferVendorFromModelName) and push
 * one channel per vendor into SyncState. Models with no detectable vendor land
 * in a `${providerName}-other` channel so they remain reachable.
 *
 * Each channel carries a fixed `ratio`; no tier expansion. This is the simple
 * shape used by OpenRouter and (post-refactor) NVIDIA — providers where every
 * model is free or where pricing is uniform per channel.
 *
 * `channelNameSuffix` lets callers add a discriminator (e.g., "-img") when
 * the same vendor must be split across channels because of differing base
 * URLs or model types.
 */
export function pushPerVendorChannels(opts: {
  models: string[];
  providerName: string;
  channelType: number;
  apiKey: string;
  baseUrl: string;
  description: string;
  ratio: number;
  state: SyncState;
  channelModelMapping?: Record<string, string>;
  channelNameSuffix?: string;
}): { vendorToModels: Map<string, string[]> } {
  const vendorToModels = new Map<string, string[]>();
  for (const model of opts.models) {
    const vendor = inferVendorFromModelName(model) ?? "other";
    if (!vendorToModels.has(vendor)) vendorToModels.set(vendor, []);
    vendorToModels.get(vendor)!.push(model);
  }

  const fullMapping = opts.channelModelMapping;
  const suffix = opts.channelNameSuffix ?? "";

  for (const [vendor, models] of [...vendorToModels.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const channelName = `${opts.providerName}-${vendor}${suffix}`;

    opts.state.mergedGroups.push({
      name: channelName,
      ratio: opts.ratio,
      description: opts.description,
      provider: opts.providerName,
    });

    let scopedMapping: Record<string, string> | undefined;
    if (fullMapping) {
      const scoped: Record<string, string> = {};
      for (const m of models) {
        if (fullMapping[m] !== undefined) scoped[m] = fullMapping[m];
      }
      if (Object.keys(scoped).length > 0) scopedMapping = scoped;
    }

    opts.state.channelsToCreate.push({
      name: channelName,
      type: opts.channelType,
      key: opts.apiKey,
      base_url: opts.baseUrl.replace(/\/$/, ""),
      models: models.join(","),
      group: channelName,
      priority: 0,
      weight: 1,
      status: 1,
      tag: opts.providerName,
      remark: channelName,
      model_mapping: scopedMapping ? JSON.stringify(scopedMapping) : undefined,
    });
  }

  return { vendorToModels };
}

/**
 * Seed a temporary synthetic group for pricing baseline, build price tiers,
 * remove the seed, and push the final tiered channels into state.
 *
 * Used by providers that need to compare their pricing against existing
 * channels from other providers (direct, nvidia text).
 */
export function seedAndPushTieredChannels(opts: {
  models: string[];
  providerName: string;
  seedPrefix: string;
  channelType: number;
  apiKey: string;
  baseUrl: string;
  vendor: string;
  description: string;
  priceAdjustment: AnyProviderConfig["priceAdjustment"];
  defaultAdjustment: number;
  ratio: number;
  state: SyncState;
  modelMapping?: Record<string, string>;
  channelModelMapping?: Record<string, string>;
}): { ratioToModels: Map<number, string[]> } {
  const syntheticGroupName = `__${opts.seedPrefix}_seed_${opts.providerName}`;

  opts.state.mergedGroups.push({
    name: syntheticGroupName,
    ratio: opts.ratio,
    description: opts.description,
    provider: opts.providerName,
  });
  opts.state.channelsToCreate.push({
    name: syntheticGroupName,
    type: opts.channelType,
    key: "",
    base_url: "",
    models: opts.models.join(","),
    group: syntheticGroupName,
    priority: 0,
    weight: 1,
    status: 1,
    tag: `__seed_${opts.providerName}`,
    remark: "synthetic seed for pricing baseline",
  });

  const ratioToModels = buildPriceTiers({
    models: opts.models,
    adj: opts.priceAdjustment,
    defaultAdjustment: opts.defaultAdjustment,
    vendor: opts.vendor,
    state: opts.state,
    excludeProvider: opts.providerName,
    modelMapping: opts.modelMapping,
  });

  const seedIdx = opts.state.channelsToCreate.findIndex(
    (c) => c.name === syntheticGroupName,
  );
  if (seedIdx >= 0) opts.state.channelsToCreate.splice(seedIdx, 1);
  const seedGroupIdx = opts.state.mergedGroups.findIndex(
    (g) => g.name === syntheticGroupName,
  );
  if (seedGroupIdx >= 0) opts.state.mergedGroups.splice(seedGroupIdx, 1);

  pushTieredChannels(
    ratioToModels,
    opts.providerName,
    {
      type: opts.channelType,
      key: opts.apiKey,
      baseUrl: opts.baseUrl,
      provider: opts.providerName,
      description: opts.description,
      modelMapping:
        opts.channelModelMapping &&
        Object.keys(opts.channelModelMapping).length > 0
          ? opts.channelModelMapping
          : undefined,
    },
    opts.state,
  );

  return { ratioToModels };
}
