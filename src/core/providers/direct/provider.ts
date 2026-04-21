import { getTestModelTypes, type RuntimeConfig } from "@core/config";
import type { DirectProviderConfig } from "@core/validations/config";
import { CHANNEL_TYPES, VENDOR_CHANNEL_TYPES } from "@core/models/constants";
import { filterModels } from "@core/models/filter";
import { testAndFilterModels } from "@core/models/tester";
import { seedAndPushTieredChannels } from "@core/providers/shared/pipeline";
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

    allModels = filterModels(allModels, config, providerConfig);
    if (allModels.length === 0) {
      providerReport.error = t("CORE.ERROR.ALL_MODELS_FILTERED");
      return providerReport;
    }

    const channelType =
      providerConfig.channelType ??
      VENDOR_CHANNEL_TYPES[providerConfig.vendor.toLowerCase()] ??
      CHANNEL_TYPES.OPENAI;

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

    if (providerConfig.vendor.toLowerCase() === "openai") {
      for (const m of workingModels) {
        if (!state.modelEndpoints.has(m)) {
          state.modelEndpoints.set(m, ["openai-response"]);
        }
      }
    }

    const mappedModels = workingModels.map(
      (m) => config.modelMapping?.[m] ?? m,
    );

    const { ratioToModels } = seedAndPushTieredChannels({
      models: mappedModels,
      providerName: providerConfig.name,
      seedPrefix: "direct",
      channelType,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      vendor: providerConfig.vendor,
      description: `${providerConfig.vendor} via ${providerConfig.name}`,
      priceAdjustment: providerConfig.priceAdjustment,
      defaultAdjustment: 0,
      ratio: providerConfig.ratio,
      state,
      modelMapping: config.modelMapping,
    });

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
