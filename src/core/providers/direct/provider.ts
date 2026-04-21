import { getTestModelTypes, type RuntimeConfig } from "@core/config";
import type { DirectProviderConfig } from "@core/validations/config";
import { CHANNEL_TYPES, VENDOR_CHANNEL_TYPES } from "@core/models/constants";
import { filterModels } from "@core/models/filter";
import { testAndFilterModels } from "@core/models/tester";
import { buildPriceTiers, pushTieredChannels } from "@core/pricing";
import type { ProviderReport, SyncState } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import { discoverModels } from "./discovery";

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
        t("CORE.PROVIDER.USING_EXPLICIT_MODELS", {
          name: providerConfig.name,
          count: allModels.length,
        }),
      );
    } else {
      allModels = await discoverModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
        providerConfig.vendor,
        providerConfig.discoverEndpoint,
      );
      if (allModels.length === 0) {
        providerReport.error = t("CORE.ERROR.NO_MODELS_DISCOVERED");
        return providerReport;
      }
      consola.info(
        t("CORE.PROVIDER.DISCOVERED_MODELS_LIST", {
          name: providerConfig.name,
          count: allModels.length,
          models: allModels.join(", "),
        }),
      );
    }

    // 2. Filter
    allModels = filterModels(allModels, config, providerConfig);
    if (allModels.length === 0) {
      providerReport.error = t("CORE.ERROR.ALL_MODELS_FILTERED");
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
      testableModelTypes: getTestModelTypes(config, providerConfig),
    });
    const workingModels = filterResult.workingModels;

    if (workingModels.length === 0) {
      providerReport.error = t("CORE.ERROR.NO_WORKING_MODELS_COUNT", {
        total: filterResult.testedCount,
      });
      return providerReport;
    }

    consola.info(
      t("CORE.PROVIDER.WORKING_RATIO", {
        name: providerConfig.name,
        working: workingModels.length,
        total: allModels.length,
      }),
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
      t("CORE.PROVIDER.TIERS_SUMMARY", {
        name: providerConfig.name,
        count: mappedModels.length,
        tiers: ratioToModels.size,
        ratios,
      }),
    );
  } catch (error) {
    providerReport.error =
      error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
