import type { AnyProviderConfig } from "@core/validations/config";
import { buildPriceTiers, pushTieredChannels } from "@core/pricing";
import type { SyncState } from "@core/types";

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
