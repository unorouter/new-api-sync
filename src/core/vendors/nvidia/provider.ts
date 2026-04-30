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
  UpstreamOffer,
} from "@core/pricing/offers";
import {
  resolveSourceMetadata,
  type PricingSource,
} from "@core/pricing/resolver";
import { NVIDIA_RETRY_POLICY } from "@core/testing/execution";
import {
  testAndFilterModels,
  type ModelCapabilityHint,
} from "@core/testing/runner";
import type { ProviderReport } from "@core/types";
import type { NvidiaProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { partitionByVendor } from "../shared/partition";
import { discoverNvidiaModels } from "./discovery";

function buildCapabilityMap(
  upstreamModels: string[],
  config: RuntimeConfig,
  ctx: {
    pricingSources: PricingSource[];
    reverseMapping: Map<string, string>;
  },
): Map<string, ModelCapabilityHint> {
  const map = new Map<string, ModelCapabilityHint>();
  for (const upstream of upstreamModels) {
    const exposed = config.modelMapping?.[upstream] ?? upstream;
    const md = resolveSourceMetadata(
      exposed,
      ctx.pricingSources,
      ctx.reverseMapping,
    );
    if (md.supportsTools !== undefined || md.isReasoning !== undefined) {
      map.set(upstream, {
        supportsTools: md.supportsTools,
        isReasoning: md.isReasoning,
      });
    }
  }
  return map;
}

export async function processNvidiaProvider(
  providerConfig: NvidiaProviderConfig,
  config: RuntimeConfig,
  ctx: {
    pricingSources: PricingSource[];
    reverseMapping: Map<string, string>;
  },
): Promise<ProviderResult> {
  const report: ProviderReport = {
    name: providerConfig.name,
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
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return { report, offers, endpointMetadata };
    }

    allModels = filterModels(allModels, config, providerConfig);
    if (allModels.length === 0) {
      report.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
      return { report, offers, endpointMetadata };
    }

    const textModels: string[] = [];
    const imageModels: string[] = [];
    for (const m of allModels) {
      if (inferModelType(m) === "image") imageModels.push(m);
      else textModels.push(m);
    }

    consola.debug(
      t("CORE.NVIDIA.SPLIT", {
        name: providerConfig.name,
        text: textModels.length,
        image: imageModels.length,
      }),
    );

    let workingTextModels: string[] = [];
    let textDetails: NonNullable<
      Awaited<ReturnType<typeof testAndFilterModels>>["details"]
    > = [];
    if (textModels.length > 0) {
      const capabilities = buildCapabilityMap(textModels, config, ctx);
      const filterResult = await testAndFilterModels({
        allModels: textModels,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        channelType: CHANNEL_TYPES.OPENAI,
        providerLabel: providerConfig.name,
        testableModelTypes: getTestModelTypes(config, providerConfig),
        retryPolicy: NVIDIA_RETRY_POLICY,
        capabilities,
      });
      workingTextModels = filterResult.workingModels;
      textDetails = filterResult.details ?? [];
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
    const textReverseMapping = buildChannelModelMapping(textResolutions);
    const imageReverseMapping = buildChannelModelMapping(imageResolutions);

    let totalVendors = 0;
    const sanitizedBase = sanitizeGroupName(providerConfig.name);

    // Text offers: free, one per vendor.
    if (textResolutions.length > 0) {
      const byVendor = partitionByVendor(
        textResolutions,
        (r) => r.exposed,
        "other",
      );
      for (const [vendor, vendorResolutions] of byVendor) {
        const offerModels: OfferModel[] = vendorResolutions.map((r) => {
          const detail = textDetails.find((d) => d.model === r.upstream);
          return {
            exposed: r.exposed,
            upstream: textReverseMapping[r.exposed] ?? r.upstream,
            modelType: "text",
            isFree: true,
            testDetail: detail,
          };
        });
        offers.push({
          provider: providerConfig.name,
          providerKind: "nvidia",
          group: vendor,
          sanitizedBase,
          vendor,
          channelType: CHANNEL_TYPES.OPENAI,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          groupRatio: providerConfig.ratio,
          channelRemark: `NVIDIA NIM text via ${providerConfig.name}`,
          models: offerModels,
          priceAdjustment: providerConfig.priceAdjustment,
          defaultAdjustment: 0,
        });
        totalVendors++;
      }
      consola.info(
        `[${providerConfig.name}] ${textResolutions.length} text model(s) across ${byVendor.size} vendor channel(s)`,
      );
    }

    // Image offers: fixed-price (modelPrice=0, quotaType=1), per-vendor with
    // -img suffix on the sanitized base so emit produces distinct channel
    // names from the text offers.
    if (imageResolutions.length > 0) {
      const byVendor = partitionByVendor(
        imageResolutions,
        (r) => r.exposed,
        "other",
      );
      const imgSanitizedBase = `${sanitizedBase}-img`;
      for (const [vendor, vendorResolutions] of byVendor) {
        const offerModels: OfferModel[] = vendorResolutions.map((r) => ({
          exposed: r.exposed,
          upstream: imageReverseMapping[r.exposed] ?? r.upstream,
          modelType: "image",
          modelPrice: 0,
          quotaType: 1,
        }));
        offers.push({
          provider: providerConfig.name,
          providerKind: "nvidia",
          group: vendor,
          sanitizedBase: imgSanitizedBase,
          vendor,
          channelType: CHANNEL_TYPES.NVIDIA_NIM,
          baseUrl: providerConfig.imageBaseUrl,
          apiKey: providerConfig.apiKey,
          groupRatio: providerConfig.ratio,
          channelRemark: `NVIDIA NIM image via ${providerConfig.name}`,
          models: offerModels,
          priceAdjustment: providerConfig.priceAdjustment,
          defaultAdjustment: 0,
        });
        totalVendors++;
      }
      consola.info(
        `[${providerConfig.name}] ${imageResolutions.length} image model(s) across ${byVendor.size} vendor channel(s)`,
      );
    }

    report.groups = totalVendors;
    report.models = allWorking.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  return { report, offers, endpointMetadata };
}
