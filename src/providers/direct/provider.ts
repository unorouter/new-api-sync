import {
  shouldSkipTesting,
  type DirectProviderConfig,
  type RuntimeConfig,
} from "@/config";
import {
  CHANNEL_TYPES,
  matchesAnyPattern,
  matchesBlacklist,
  VENDOR_CHANNEL_TYPES,
} from "@/lib/constants";
import { testAndFilterModels } from "@/lib/model-tester";
import { buildPriceTiers, pushTieredChannels } from "@/lib/pricing";
import type { ProviderReport, SyncState } from "@/lib/types";
import { consola } from "consola";
import { discoverModels } from "./discovery";

function filterModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: DirectProviderConfig,
): string[] {
  return models.filter((id) => {
    if (matchesBlacklist(id, config.blacklist, providerConfig.name))
      return false;
    if (providerConfig.enabledModels?.length) {
      if (!matchesAnyPattern(id, providerConfig.enabledModels)) return false;
    }
    return true;
  });
}

export async function processDirectProvider(
  providerConfig: DirectProviderConfig,
  config: RuntimeConfig,
  state: SyncState,
): Promise<ProviderReport> {
  const providerReport: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };

  try {
    // 1. Resolve models: explicit list or auto-discover
    let allModels: string[];
    if (providerConfig.models?.length) {
      allModels = providerConfig.models;
      consola.info(
        `[${providerConfig.name}] Using ${allModels.length} explicit model(s)`,
      );
    } else {
      allModels = await discoverModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
        providerConfig.vendor,
        providerConfig.discoverEndpoint,
      );
      if (allModels.length === 0) {
        providerReport.error =
          "No models discovered. Add an explicit 'models' array to the provider config.";
        return providerReport;
      }
      consola.info(
        `[${providerConfig.name}] Discovered ${allModels.length} model(s): ${allModels.join(", ")}`,
      );
    }

    // 2. Filter
    allModels = filterModels(allModels, config, providerConfig);
    if (allModels.length === 0) {
      providerReport.error = "All models filtered out by blacklist/enabledModels";
      return providerReport;
    }

    // 3. Resolve channel type
    const channelType =
      providerConfig.channelType ??
      VENDOR_CHANNEL_TYPES[providerConfig.vendor.toLowerCase()] ??
      CHANNEL_TYPES.OPENAI;

    // 4. Test models
    const filterResult = await testAndFilterModels({
      allModels,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      channelType,
      providerLabel: providerConfig.name,
      skipTesting: shouldSkipTesting(config, providerConfig),
    });
    const workingModels = filterResult.workingModels;

    if (workingModels.length === 0) {
      providerReport.error = `No working models (0/${filterResult.testedCount} passed)`;
      return providerReport;
    }

    consola.info(
      `[${providerConfig.name}] ${workingModels.length}/${allModels.length} working`,
    );

    // 5. Register endpoint types for OpenAI vendor (responses API policy)
    if (providerConfig.vendor.toLowerCase() === "openai") {
      for (const m of workingModels) {
        if (!state.modelEndpoints.has(m)) {
          state.modelEndpoints.set(m, ["openai-response"]);
        }
      }
    }

    // 6. Apply model mapping
    const mappedModels = workingModels.map(
      (m) => config.modelMapping?.[m] ?? m,
    );

    // 7. Seed a synthetic group at the configured ratio so buildPriceTiers
    //    can find it as the baseline for models that have no other provider.
    const syntheticGroupName = `__direct_seed_${providerConfig.name}`;
    state.mergedGroups.push({
      name: syntheticGroupName,
      ratio: providerConfig.ratio,
      description: `${providerConfig.vendor} via ${providerConfig.name}`,
      provider: providerConfig.name,
    });
    state.channelsToCreate.push({
      name: syntheticGroupName,
      type: channelType,
      key: "",
      base_url: "",
      models: mappedModels.join(","),
      group: syntheticGroupName,
      priority: 0,
      weight: 1,
      status: 1,
      tag: `__seed_${providerConfig.name}`,
      remark: "synthetic seed for pricing baseline",
    });

    // 8. Build price tiers
    const ratioToModels = buildPriceTiers({
      models: mappedModels,
      adj: providerConfig.priceAdjustment,
      defaultAdjustment: 0,
      vendor: providerConfig.vendor,
      state,
      excludeProvider: providerConfig.name,
      modelMapping: config.modelMapping,
    });

    // Remove synthetic seed channel (it served its purpose for pricing)
    const seedIdx = state.channelsToCreate.findIndex(
      (c) => c.name === syntheticGroupName,
    );
    if (seedIdx >= 0) state.channelsToCreate.splice(seedIdx, 1);
    const seedGroupIdx = state.mergedGroups.findIndex(
      (g) => g.name === syntheticGroupName,
    );
    if (seedGroupIdx >= 0) state.mergedGroups.splice(seedGroupIdx, 1);

    // 9. Push tiered channels
    pushTieredChannels(
      ratioToModels,
      providerConfig.name,
      {
        type: channelType,
        key: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        provider: providerConfig.name,
        description: `${providerConfig.vendor} via ${providerConfig.name}`,
      },
      state,
    );

    providerReport.groups = ratioToModels.size;
    providerReport.models = mappedModels.length;
    providerReport.success = true;

    const ratios = [...ratioToModels.keys()]
      .map((r) => r.toFixed(4))
      .join(", ");
    consola.info(
      `[${providerConfig.name}] ${mappedModels.length} models, ${ratioToModels.size} tier(s): ${ratios}`,
    );
  } catch (error) {
    providerReport.error =
      error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
