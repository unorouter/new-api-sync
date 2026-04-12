import {
  getEnabledModelGlobs,
  getTestModelTypes,
  type NvidiaProviderConfig,
  type RuntimeConfig,
} from "@core/config";
import { CHANNEL_TYPES, inferModelType } from "@core/lib/constants";
import { filterModels } from "@core/lib/model-filter";
import { testAndFilterModels } from "@core/lib/model-tester";
import { buildPriceTiers, pushTieredChannels } from "@core/lib/pricing";
import type { ProviderReport, SyncState } from "@core/lib/types";
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
    // 1. Resolve models: explicit list or auto-discover + enabledModels
    let allModels: string[];
    if (providerConfig.models?.length) {
      allModels = providerConfig.models;
      consola.info(
        `[${providerConfig.name}] Using ${allModels.length} explicit model(s)`,
      );
    } else {
      // Discover text models from OpenAI-compat /v1/models
      allModels = await discoverNvidiaModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      consola.info(
        `[${providerConfig.name}] Discovered ${allModels.length} model(s)`,
      );

      // Image models live on a different host and aren't discoverable.
      // Add any enabledModels entries that are image type so they get included.
      const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
      if (enabledGlobs?.length) {
        const discoveredSet = new Set(allModels);
        for (const glob of enabledGlobs) {
          // Only add literal model names (not wildcards) that are image type
          if (!glob.includes("*") && !glob.includes("?")) {
            if (!discoveredSet.has(glob) && inferModelType(glob) === "image") {
              allModels.push(glob);
              consola.debug(
                `[${providerConfig.name}] Added image model from enabledModels: ${glob}`,
              );
            }
          }
        }
      }
    }

    if (allModels.length === 0) {
      providerReport.error = "No models found";
      return providerReport;
    }

    // 2. Filter by enabledModels/blacklist
    allModels = filterModels(allModels, config, providerConfig);
    if (allModels.length === 0) {
      providerReport.error = "All models filtered out";
      return providerReport;
    }

    // 3. Split into text vs non-text using inferModelType
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
      `[${providerConfig.name}] Split: ${textModels.length} text, ${imageModels.length} image`,
    );

    // 4. Test text models (OpenAI-compat endpoint)
    let workingTextModels: string[] = [];
    if (textModels.length > 0) {
      const filterResult = await testAndFilterModels({
        allModels: textModels,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        channelType: CHANNEL_TYPES.OPENAI,
        providerLabel: providerConfig.name,
        testableModelTypes: getTestModelTypes(config, providerConfig),
      });
      workingTextModels = filterResult.workingModels;

      if (workingTextModels.length > 0) {
        consola.info(
          `[${providerConfig.name}] ${workingTextModels.length}/${textModels.length} text models working`,
        );
      }
    }

    // 5. Image models included without testing (proprietary NIM API format)
    if (imageModels.length > 0) {
      consola.info(
        `[${providerConfig.name}] ${imageModels.length} image model(s) included without test`,
      );
    }

    const allWorking = [...workingTextModels, ...imageModels];
    if (allWorking.length === 0) {
      providerReport.error = `No working models (0/${textModels.length} text passed, ${imageModels.length} image)`;
      return providerReport;
    }

    // 6. Apply model mapping
    const mappedTextModels = workingTextModels.map(
      (m) => config.modelMapping?.[m] ?? m,
    );
    const mappedImageModels = imageModels.map(
      (m) => config.modelMapping?.[m] ?? m,
    );

    // 7. Create text channels (OpenAI channel type)
    if (mappedTextModels.length > 0) {
      const syntheticGroupName = `__nvidia_seed_${providerConfig.name}_text`;
      state.mergedGroups.push({
        name: syntheticGroupName,
        ratio: providerConfig.ratio,
        description: `NVIDIA NIM text via ${providerConfig.name}`,
        provider: providerConfig.name,
      });
      state.channelsToCreate.push({
        name: syntheticGroupName,
        type: CHANNEL_TYPES.OPENAI,
        key: "",
        base_url: "",
        models: mappedTextModels.join(","),
        group: syntheticGroupName,
        priority: 0,
        weight: 1,
        status: 1,
        tag: `__seed_${providerConfig.name}`,
        remark: "synthetic seed for pricing baseline",
      });

      const ratioToModels = buildPriceTiers({
        models: mappedTextModels,
        adj: providerConfig.priceAdjustment,
        defaultAdjustment: 0,
        vendor: "nvidia",
        state,
        excludeProvider: providerConfig.name,
        modelMapping: config.modelMapping,
      });

      // Remove synthetic seed
      const seedIdx = state.channelsToCreate.findIndex(
        (c) => c.name === syntheticGroupName,
      );
      if (seedIdx >= 0) state.channelsToCreate.splice(seedIdx, 1);
      const seedGroupIdx = state.mergedGroups.findIndex(
        (g) => g.name === syntheticGroupName,
      );
      if (seedGroupIdx >= 0) state.mergedGroups.splice(seedGroupIdx, 1);

      pushTieredChannels(
        ratioToModels,
        providerConfig.name,
        {
          type: CHANNEL_TYPES.OPENAI,
          key: providerConfig.apiKey,
          baseUrl: providerConfig.baseUrl,
          provider: providerConfig.name,
          description: `NVIDIA NIM text via ${providerConfig.name}`,
        },
        state,
      );

      const ratios = [...ratioToModels.keys()]
        .map((r) => r.toFixed(4))
        .join(", ");
      consola.info(
        `[${providerConfig.name}] ${mappedTextModels.length} text models, ${ratioToModels.size} tier(s): ${ratios}`,
      );
    }

    // 8. Create image channels (NvidiaNIM channel type 58)
    if (mappedImageModels.length > 0) {
      const imageBaseUrl = providerConfig.imageBaseUrl;
      const groupName = `nvidia-img-${providerConfig.name}`;

      state.mergedGroups.push({
        name: groupName,
        ratio: 0,
        description: `NVIDIA NIM image via ${providerConfig.name}`,
        provider: providerConfig.name,
      });

      // Build reverse model_mapping so the adaptor sends the original
      // vendor-prefixed name (e.g. "stabilityai/stable-diffusion-3-medium")
      // to the NVIDIA endpoint while users see the short mapped name.
      const imgModelMapping: Record<string, string> = {};
      for (const original of imageModels) {
        const mapped = config.modelMapping?.[original] ?? original;
        if (mapped !== original) {
          imgModelMapping[mapped] = original;
        }
      }

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
          Object.keys(imgModelMapping).length > 0
            ? JSON.stringify(imgModelMapping)
            : undefined,
      });

      for (const model of mappedImageModels) {
        // Always override: partial sync may have seeded a stale ratio-based entry
        state.mergedModels.set(model, {
          ratio: 0,
          completionRatio: 0,
          modelPrice: 0,
          quotaType: 1,
        });
      }

      consola.info(
        `[${providerConfig.name}] ${mappedImageModels.length} image model(s) → channel "${groupName}" (type=${CHANNEL_TYPES.NVIDIA_NIM})`,
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
