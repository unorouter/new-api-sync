import { getTestModelTypes, type RuntimeConfig } from "@core/config";
import type { DirectProviderConfig } from "@core/validations/config";
import {
  CHANNEL_TYPES,
  inferModelType,
  inferVendorFromModelName,
  sanitizeGroupName,
  VENDOR_CHANNEL_TYPES,
} from "@core/models/constants";
import { filterModels } from "@core/models/filter";
import { testAndFilterModels } from "@core/models/tester";
import type {
  OfferModel,
  ProviderResult,
  UpstreamOffer,
} from "@core/pricing/offers";
import type { ProviderReport } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import { discoverModels } from "./discovery";

export async function processDirectProvider(
  providerConfig: DirectProviderConfig,
  config: RuntimeConfig,
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
      allModels = await discoverModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
        providerConfig.vendor,
        providerConfig.discoverEndpoint,
      );
      if (allModels.length === 0) {
        report.error = t("CORE.ERROR.NO_MODELS_DISCOVERED");
        return { report, offers, endpointMetadata };
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
      report.error = t("CORE.ERROR.ALL_MODELS_FILTERED");
      return { report, offers, endpointMetadata };
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
      report.error = t("CORE.ERROR.NO_WORKING_MODELS_COUNT", {
        total: filterResult.testedCount,
      });
      return { report, offers, endpointMetadata };
    }

    consola.info(
      t("CORE.PROVIDER.WORKING_RATIO", {
        name: providerConfig.name,
        working: workingModels.length,
        total: allModels.length,
      }),
    );

    const responsesApiEndpoints =
      providerConfig.vendor.toLowerCase() === "openai"
        ? ["openai-response"]
        : undefined;

    // One offer per vendor (direct providers serve a single vendor each).
    // upstreamRatio is undefined: the compute function uses the
    // "cheapest existing group ratio across baseline + other tiers" path.
    const offerModels: OfferModel[] = workingModels.map((upstreamName) => {
      const exposed = config.modelMapping?.[upstreamName] ?? upstreamName;
      const detail = filterResult.details?.find((d) => d.model === upstreamName);
      return {
        exposed,
        upstream: upstreamName,
        modelType: inferModelType(exposed, responsesApiEndpoints),
        endpoints: responsesApiEndpoints,
        normalizedEndpoints: responsesApiEndpoints,
        testDetail: detail,
      };
    });

    const sanitizedBase = sanitizeGroupName(providerConfig.name);

    offers.push({
      provider: providerConfig.name,
      providerKind: "direct",
      group: providerConfig.name,
      sanitizedBase,
      vendor: providerConfig.vendor,
      channelType,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      groupRatio: providerConfig.ratio,
      channelRemark: `${providerConfig.vendor} via ${providerConfig.name}`,
      models: offerModels,
      priceAdjustment: providerConfig.priceAdjustment,
      defaultAdjustment: 0,
      maxRatioCap: providerConfig.maxRatioCap ?? config.maxRatioCap,
    });

    report.groups = 1;
    report.models = offerModels.length;
    report.success = true;
    void inferVendorFromModelName; // kept for future use
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  return { report, offers, endpointMetadata };
}
