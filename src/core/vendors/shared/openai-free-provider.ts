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
import type { ModelType, ProviderReport } from "@core/types";
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
  /** Channel type for testing + emitted channels. Defaults to OPENAI; Z.ai uses
   *  ZHIPU_V4 (OpenAI body at the /v4 path). */
  channelType?: number;
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
  channelType?: number;
  /** Defaults to "text". Set "embedding"/"image"/"audio" for non-chat modalities. */
  modelType?: ModelType;
  /** new-api endpoint tags carried on each OfferModel (e.g. ["embedding"]). */
  endpoints?: string[];
}): UpstreamOffer[] {
  const offers: UpstreamOffer[] = [];
  const channelType = opts.channelType ?? CHANNEL_TYPES.OPENAI;
  const modelType = opts.modelType ?? "text";
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
        modelType,
        isFree: true,
        testDetail: opts.details.find((d) => d.model === x.upstream),
        ...(opts.endpoints ? { endpoints: opts.endpoints } : {}),
        ...(maxOut ? { metadata: { maxOutputTokens: maxOut } } : {}),
      };
    });
    offers.push({
      provider: opts.provider,
      providerKind: opts.providerKind,
      group: vendor,
      sanitizedBase: opts.sanitizedBase,
      vendor,
      channelType,
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

    const channelType = opts.channelType ?? CHANNEL_TYPES.OPENAI;
    const mapExposed = (opts.exposedMapper ?? passthroughExposed)(config);
    let totalWorking = 0;

    // Each modality the simple OpenAI-compat surface can serve. text uses the
    // provider's channelType; embeddings always route through the OpenAI channel
    // (every provider here exposes /v1/embeddings) with the "embedding" tag.
    const modalities: {
      modelType: ModelType;
      channelType: number;
      endpoints?: string[];
    }[] = [
      { modelType: "text", channelType },
      {
        modelType: "embedding",
        channelType: CHANNEL_TYPES.OPENAI,
        endpoints: ["embedding"],
      },
    ];

    for (const modality of modalities) {
      const models = allModels.filter(
        (m) => inferModelType(m) === modality.modelType,
      );
      if (models.length === 0) continue;
      // Probe each modality as itself (text -> chat, embedding -> /embeddings),
      // not via the text-only config default, so non-chat models are verified too.
      const r = await testAndFilterModels({
        allModels: models,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        channelType: modality.channelType,
        providerLabel: name,
        testableModelTypes: new Set([modality.modelType]),
        retryPolicy: opts.retryPolicy ?? NVIDIA_RETRY_POLICY,
        capabilities: buildCapabilityMap(models, mapExposed, ctx),
      });
      const working = r.workingModels;
      if (working.length === 0) continue;
      totalWorking += working.length;
      consola.info(
        t("CORE.NVIDIA.TEXT_WORKING", {
          name,
          working: working.length,
          total: models.length,
        }),
      );
      const resolutions = resolveBareNames(working, config.modelMapping);
      offers.push(
        ...emitFreeTextOffers({
          resolutions,
          rev: buildChannelModelMapping(resolutions),
          details: r.details ?? [],
          maxOutputByModel,
          provider: name,
          providerKind: opts.providerKind,
          sanitizedBase: sanitizeGroupName(name),
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          groupRatio: providerConfig.ratio,
          channelRemark: `${opts.channelRemarkLabel} via ${name}`,
          priceAdjustment: providerConfig.priceAdjustment,
          channelType: modality.channelType,
          modelType: modality.modelType,
          endpoints: modality.endpoints,
        }),
      );
    }

    if (totalWorking === 0) {
      report.error = t("CORE.ERROR.NO_WORKING_MODELS");
      return { report, offers, endpointMetadata };
    }
    report.groups = offers.length;
    report.models = totalWorking;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return { report, offers, endpointMetadata };
}
