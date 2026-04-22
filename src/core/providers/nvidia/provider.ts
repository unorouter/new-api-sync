import {
  getEnabledModelGlobs,
  getTestModelTypes,
  type RuntimeConfig,
} from "@core/config";
import type { NvidiaProviderConfig } from "@core/validations/config";
import {
  buildChannelModelMapping,
  resolveBareNames,
} from "@core/models/bare-name";
import { CHANNEL_TYPES, inferModelType } from "@core/models/constants";
import { filterModels } from "@core/models/filter";
import { NVIDIA_RETRY_POLICY } from "@core/models/testing/execution";
import { testAndFilterModels } from "@core/models/tester";
import { seedAndPushTieredChannels } from "@core/providers/shared/pipeline";
import type { ProviderReport, SyncState } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import { discoverNvidiaModels } from "./discovery";

export async function processNvidiaProvider(
  providerConfig: NvidiaProviderConfig,
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
      allModels = await discoverNvidiaModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      consola.info(
        t("CORE.PROVIDER.DISCOVERED_MODELS", {
          name: providerConfig.name,
          count: allModels.length,
        }),
      );

      const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
      if (enabledGlobs?.length) {
        const discoveredSet = new Set(allModels);
        for (const glob of enabledGlobs) {
          if (!glob.includes("*") && !glob.includes("?")) {
            if (!discoveredSet.has(glob) && inferModelType(glob) === "image") {
              allModels.push(glob);
              consola.debug(
                t("CORE.NVIDIA.ENABLED_IMAGE_MODEL_ADDED", {
                  name: providerConfig.name,
                  glob,
                }),
              );
            }
          }
        }
      }
    }

    if (allModels.length === 0) {
      providerReport.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return providerReport;
    }

    allModels = filterModels(allModels, config, providerConfig);
    if (allModels.length === 0) {
      providerReport.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
      return providerReport;
    }

    const textModels: string[] = [];
    const imageModels: string[] = [];
    for (const model of allModels) {
      const modelType = inferModelType(model);
      if (modelType === "image") {
        imageModels.push(model);
      } else {
        textModels.push(model);
      }
    }

    consola.debug(
      t("CORE.NVIDIA.SPLIT", {
        name: providerConfig.name,
        text: textModels.length,
        image: imageModels.length,
      }),
    );

    let workingTextModels: string[] = [];
    if (textModels.length > 0) {
      const filterResult = await testAndFilterModels({
        allModels: textModels,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        channelType: CHANNEL_TYPES.OPENAI,
        providerLabel: providerConfig.name,
        testableModelTypes: getTestModelTypes(config, providerConfig),
        retryPolicy: NVIDIA_RETRY_POLICY,
      });
      workingTextModels = filterResult.workingModels;

      if (workingTextModels.length > 0) {
        consola.info(
          t("CORE.NVIDIA.TEXT_WORKING", {
            name: providerConfig.name,
            working: workingTextModels.length,
            total: textModels.length,
          }),
        );
      }
    }

    if (imageModels.length > 0) {
      consola.info(
        t("CORE.NVIDIA.IMAGE_INCLUDED", {
          name: providerConfig.name,
          count: imageModels.length,
        }),
      );
    }

    const allWorking = [...workingTextModels, ...imageModels];
    if (allWorking.length === 0) {
      providerReport.error = t("CORE.ERROR.NO_WORKING_MODELS_SPLIT", {
        textTotal: textModels.length,
        imageCount: imageModels.length,
      });
      return providerReport;
    }

    const textResolutions = resolveBareNames(
      workingTextModels,
      config.modelMapping,
    );
    const imageResolutions = resolveBareNames(
      imageModels,
      config.modelMapping,
    );
    const mappedTextModels = textResolutions.map((r) => r.exposed);
    const mappedImageModels = imageResolutions.map((r) => r.exposed);
    const textReverseMapping = buildChannelModelMapping(textResolutions);
    const imageReverseMapping = buildChannelModelMapping(imageResolutions);

    if (mappedTextModels.length > 0) {
      const { ratioToModels } = seedAndPushTieredChannels({
        models: mappedTextModels,
        providerName: providerConfig.name,
        seedPrefix: "nvidia_text",
        channelType: CHANNEL_TYPES.OPENAI,
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        vendor: "nvidia",
        description: `NVIDIA NIM text via ${providerConfig.name}`,
        priceAdjustment: providerConfig.priceAdjustment,
        defaultAdjustment: 0,
        ratio: providerConfig.ratio,
        state,
        modelMapping: config.modelMapping,
        channelModelMapping:
          Object.keys(textReverseMapping).length > 0
            ? textReverseMapping
            : undefined,
      });

      const ratios = [...ratioToModels.keys()]
        .map((r) => r.toFixed(4))
        .join(", ");
      consola.info(
        t("CORE.NVIDIA.TEXT_TIERS_SUMMARY", {
          name: providerConfig.name,
          count: mappedTextModels.length,
          tiers: ratioToModels.size,
          ratios,
        }),
      );
    }

    if (mappedImageModels.length > 0) {
      const imageBaseUrl = providerConfig.imageBaseUrl;
      const groupName = `nvidia-img-${providerConfig.name}`;

      state.mergedGroups.push({
        name: groupName,
        ratio: 0,
        description: `NVIDIA NIM image via ${providerConfig.name}`,
        provider: providerConfig.name,
      });

      state.channelsToCreate.push({
        name: groupName,
        type: CHANNEL_TYPES.NVIDIA_NIM,
        key: providerConfig.apiKey,
        base_url: imageBaseUrl,
        models: mappedImageModels.join(","),
        group: groupName,
        priority: 0,
        weight: 1,
        status: 1,
        tag: providerConfig.name,
        remark: `nvidia-img-${providerConfig.name}`,
        model_mapping:
          Object.keys(imageReverseMapping).length > 0
            ? JSON.stringify(imageReverseMapping)
            : undefined,
      });

      for (const model of mappedImageModels) {
        state.mergedModels.set(model, {
          ratio: 0,
          completionRatio: 0,
          modelPrice: 0,
          quotaType: 1,
        });
      }

      consola.info(
        t("CORE.NVIDIA.IMAGE_CHANNEL", {
          name: providerConfig.name,
          count: mappedImageModels.length,
          group: groupName,
          type: CHANNEL_TYPES.NVIDIA_NIM,
        }),
      );
    }

    providerReport.groups =
      (mappedTextModels.length > 0 ? 1 : 0) +
      (mappedImageModels.length > 0 ? 1 : 0);
    providerReport.models = allWorking.length;
    providerReport.success = true;
  } catch (error) {
    providerReport.error =
      error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
