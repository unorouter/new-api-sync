import {
  buildChannelModelMapping,
  resolveBareNames,
} from "@core/catalog/bare-name";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import { filterModels } from "@core/catalog/filter";
import {
  getEnabledModelGlobs,
  getTestModelTypes,
  type RuntimeConfig,
} from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { NVIDIA_RETRY_POLICY } from "@core/testing/execution";
import { testAndFilterModels } from "@core/testing/runner";
import type { ProviderReport } from "@core/types";
import type { NvidiaProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import {
  buildCapabilityMap,
  passthroughExposed,
} from "../shared/capability-map";
import { partitionByVendor } from "../shared/partition";
import { discoverNvidiaModels } from "./discovery";

export async function processNvidiaProvider(
  providerConfig: NvidiaProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): Promise<ProviderResult> {
  const name = providerConfig.name;
  const report: ProviderReport = {
    name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  const endpointMetadata = { endpointPaths: new Map() };

  try {
    let allModels: string[];
    if (providerConfig.models?.length) {
      allModels = providerConfig.models;
      consola.info(
        t("CORE.PROVIDER.USING_EXPLICIT_MODELS", {
          name,
          count: allModels.length,
        }),
      );
    } else {
      allModels = await discoverNvidiaModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      consola.info(
        t("CORE.PROVIDER.DISCOVERED_MODELS", { name, count: allModels.length }),
      );
      const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
      if (enabledGlobs?.length) {
        const discoveredSet = new Set(allModels);
        for (const glob of enabledGlobs) {
          if (glob.includes("*") || glob.includes("?")) continue;
          if (!discoveredSet.has(glob) && inferModelType(glob) === "image")
            allModels.push(glob);
        }
      }
    }
    if (allModels.length === 0) {
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return { report, offers, endpointMetadata };
    }
    allModels = filterModels(allModels, config, providerConfig);
    if (allModels.length === 0) {
      report.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
      return { report, offers, endpointMetadata };
    }

    const textModels: string[] = [],
      imageModels: string[] = [];
    for (const m of allModels)
      (inferModelType(m) === "image" ? imageModels : textModels).push(m);

    let workingTextModels: string[] = [];
    let textDetails: NonNullable<
      Awaited<ReturnType<typeof testAndFilterModels>>["details"]
    > = [];
    if (textModels.length > 0) {
      const r = await testAndFilterModels({
        allModels: textModels,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        channelType: CHANNEL_TYPES.OPENAI,
        providerLabel: name,
        testableModelTypes: getTestModelTypes(config, providerConfig),
        // NIM cold-starts flagship containers (550B/675B/MoE) well past the 20s
        // default, so they timeout on first probe. Give the probe room.
        timeoutMs: 60_000,
        retryPolicy: NVIDIA_RETRY_POLICY,
        capabilities: buildCapabilityMap(
          textModels,
          passthroughExposed(config),
          ctx,
        ),
      });
      workingTextModels = r.workingModels;
      textDetails = r.details ?? [];
      if (workingTextModels.length > 0)
        consola.info(
          t("CORE.NVIDIA.TEXT_WORKING", {
            name,
            working: workingTextModels.length,
            total: textModels.length,
          }),
        );
    }
    if (imageModels.length > 0)
      consola.info(
        t("CORE.NVIDIA.IMAGE_INCLUDED", { name, count: imageModels.length }),
      );

    const allWorking = [...workingTextModels, ...imageModels];
    if (allWorking.length === 0) {
      report.error = t("CORE.ERROR.NO_WORKING_MODELS_SPLIT", {
        textTotal: textModels.length,
        imageCount: imageModels.length,
      });
      return { report, offers, endpointMetadata };
    }

    const textResolutions = resolveBareNames(
      workingTextModels,
      config.modelMapping,
    );
    const imageResolutions = resolveBareNames(imageModels, config.modelMapping);
    const textRev = buildChannelModelMapping(textResolutions);
    const imageRev = buildChannelModelMapping(imageResolutions);

    let totalVendors = 0;
    const sanitizedBase = sanitizeGroupName(name);

    const emit = (
      resolutions: typeof textResolutions,
      rev: Record<string, string>,
      isImage: boolean,
    ) => {
      if (resolutions.length === 0) return;
      const byVendor = partitionByVendor(
        resolutions,
        (r) => r.exposed,
        "other",
      );
      for (const [vendor, vendorResolutions] of byVendor) {
        const offerModels: OfferModel[] = vendorResolutions.map((r) =>
          isImage
            ? {
                exposed: r.exposed,
                upstream: rev[r.exposed] ?? r.upstream,
                modelType: "image",
                modelPrice: 0,
                quotaType: 1,
              }
            : {
                exposed: r.exposed,
                upstream: rev[r.exposed] ?? r.upstream,
                modelType: "text",
                isFree: true,
                testDetail: textDetails.find((d) => d.model === r.upstream),
              },
        );
        offers.push({
          provider: name,
          providerKind: "nvidia",
          group: vendor,
          sanitizedBase: isImage ? `${sanitizedBase}-img` : sanitizedBase,
          vendor,
          channelType: isImage
            ? CHANNEL_TYPES.NVIDIA_NIM
            : CHANNEL_TYPES.OPENAI,
          baseUrl: isImage
            ? providerConfig.imageBaseUrl
            : providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          groupRatio: providerConfig.ratio,
          channelRemark: `NVIDIA NIM ${isImage ? "image" : "text"} via ${name}`,
          models: offerModels,
          ...(isImage ? {} : { isFreeTier: true }),
          priceAdjustment: providerConfig.priceAdjustment,
          defaultAdjustment: 0,
        });
        totalVendors++;
      }
      consola.info(
        t(
          isImage
            ? "CORE.NVIDIA.IMAGE_VENDOR_CHANNELS"
            : "CORE.NVIDIA.TEXT_VENDOR_CHANNELS",
          { name, count: resolutions.length, vendors: byVendor.size },
        ),
      );
    };

    emit(textResolutions, textRev, false);
    emit(imageResolutions, imageRev, true);

    report.groups = totalVendors;
    report.models = allWorking.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return { report, offers, endpointMetadata };
}
