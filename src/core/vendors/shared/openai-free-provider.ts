import {
  buildChannelModelMapping,
  resolveBareNames,
} from "@core/catalog/bare-name";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import { filterModels } from "@core/catalog/filter";
import { getTestModelTypes, type RuntimeConfig } from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  UpstreamOffer,
} from "@core/pricing/offers";
import type { PricingSource } from "@core/pricing/resolver";
import { NVIDIA_RETRY_POLICY, type RetryPolicy } from "@core/testing/execution";
import { testAndFilterModels } from "@core/testing/runner";
import type { TestExchange } from "@core/testing/types";
import type { ProviderReport } from "@core/types";
import type { SimpleFreeProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildCapabilityMap, passthroughExposed } from "./capability-map";
import { partitionByVendor } from "./partition";

export interface OpenAIFreeDiscovery {
  models: string[];
  /** upstream model id -> documented max output tokens. */
  maxOutputByModel: Map<string, number>;
}

interface Ctx {
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
}

export interface OpenAIFreeOpts {
  providerConfig: SimpleFreeProviderConfig;
  config: RuntimeConfig;
  ctx: Ctx;
  /** offer.providerKind, e.g. "groq". */
  providerKind: string;
  /** brand label, channel remark becomes "<label> via <name>". */
  channelRemarkLabel: string;
  discover: (baseUrl: string, apiKey: string) => Promise<OpenAIFreeDiscovery>;
  retryPolicy?: RetryPolicy<TestExchange>;
  exposedMapper?: (config: RuntimeConfig) => (upstream: string) => string;
}

type Resolution = ReturnType<typeof resolveBareNames>[number];

/** Emit one free UpstreamOffer per inferred vendor. Reusable by nvidia text + openrouter free branches. */
export function emitFreeTextOffers(opts: {
  resolutions: Resolution[];
  rev: Record<string, string>;
  details: NonNullable<
    Awaited<ReturnType<typeof testAndFilterModels>>["details"]
  >;
  maxOutputByModel: Map<string, number>;
  provider: string;
  providerKind: string;
  sanitizedBase: string;
  baseUrl: string;
  apiKey: string;
  groupRatio: number;
  channelRemark: string;
  priceAdjustment?: UpstreamOffer["priceAdjustment"];
}): UpstreamOffer[] {
  const offers: UpstreamOffer[] = [];
  const byVendor = partitionByVendor(
    opts.resolutions,
    (x) => x.exposed,
    "other",
  );
  for (const [vendor, vendorResolutions] of byVendor) {
    const offerModels: OfferModel[] = vendorResolutions.map((x) => {
      const upstream = opts.rev[x.exposed] ?? x.upstream;
      const maxOut = opts.maxOutputByModel.get(upstream);
      return {
        exposed: x.exposed,
        upstream,
        modelType: "text",
        isFree: true,
        testDetail: opts.details.find((d) => d.model === x.upstream),
        ...(maxOut ? { metadata: { maxOutputTokens: maxOut } } : {}),
      };
    });
    offers.push({
      provider: opts.provider,
      providerKind: opts.providerKind,
      group: vendor,
      sanitizedBase: opts.sanitizedBase,
      vendor,
      channelType: CHANNEL_TYPES.OPENAI,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      groupRatio: opts.groupRatio,
      channelRemark: opts.channelRemark,
      models: offerModels,
      isFreeTier: true,
      priceAdjustment: opts.priceAdjustment,
      defaultAdjustment: 0,
    });
  }
  return offers;
}

/** Discover -> test -> emit free text channels. Shared by every simple OpenAI-compatible free provider. */
export async function processOpenAICompatibleFreeProvider(
  opts: OpenAIFreeOpts,
): Promise<ProviderResult> {
  const providerConfig = opts.providerConfig;
  const config = opts.config;
  const ctx = opts.ctx;
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
    let maxOutputByModel = new Map<string, number>();
    if (providerConfig.models?.length) {
      allModels = providerConfig.models;
      consola.info(
        t("CORE.PROVIDER.USING_EXPLICIT_MODELS", {
          name,
          count: allModels.length,
        }),
      );
    } else {
      const discovered = await opts.discover(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      allModels = discovered.models;
      maxOutputByModel = discovered.maxOutputByModel;
      consola.info(
        t("CORE.PROVIDER.DISCOVERED_MODELS", { name, count: allModels.length }),
      );
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

    const textModels = allModels.filter((m) => inferModelType(m) === "text");
    if (textModels.length === 0) {
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return { report, offers, endpointMetadata };
    }

    const mapExposed = (opts.exposedMapper ?? passthroughExposed)(config);
    const r = await testAndFilterModels({
      allModels: textModels,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      channelType: CHANNEL_TYPES.OPENAI,
      providerLabel: name,
      testableModelTypes: getTestModelTypes(config, providerConfig),
      retryPolicy: opts.retryPolicy ?? NVIDIA_RETRY_POLICY,
      capabilities: buildCapabilityMap(textModels, mapExposed, ctx),
    });
    const workingTextModels = r.workingModels;
    const textDetails = r.details ?? [];
    if (workingTextModels.length === 0) {
      report.error = t("CORE.ERROR.NO_WORKING_MODELS");
      return { report, offers, endpointMetadata };
    }
    consola.info(
      t("CORE.NVIDIA.TEXT_WORKING", {
        name,
        working: workingTextModels.length,
        total: textModels.length,
      }),
    );

    const resolutions = resolveBareNames(
      workingTextModels,
      config.modelMapping,
    );
    const rev = buildChannelModelMapping(resolutions);
    offers.push(
      ...emitFreeTextOffers({
        resolutions,
        rev,
        details: textDetails,
        maxOutputByModel,
        provider: name,
        providerKind: opts.providerKind,
        sanitizedBase: sanitizeGroupName(name),
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        groupRatio: providerConfig.ratio,
        channelRemark: `${opts.channelRemarkLabel} via ${name}`,
        priceAdjustment: providerConfig.priceAdjustment,
      }),
    );

    consola.info(
      t("CORE.NVIDIA.TEXT_VENDOR_CHANNELS", {
        name,
        count: resolutions.length,
        vendors: offers.length,
      }),
    );

    report.groups = offers.length;
    report.models = workingTextModels.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return { report, offers, endpointMetadata };
}
