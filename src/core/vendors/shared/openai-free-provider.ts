import {
  buildChannelModelMapping,
  resolveBareNames,
} from "@core/catalog/bare-name";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import {
  matchesAnyPattern,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { filterModels } from "@core/catalog/filter";
import { getTestModelTypes, type RuntimeConfig } from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
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
  /** Authoritative modality per model when the provider catalog declares it
   *  (e.g. Cloudflare's task). Overrides name-based inferModelType. */
  modelTypeHints?: Map<string, ModelType>;
}

export interface OpenAIFreeOpts {
  providerConfig: SimpleFreeProviderConfig;
  config: RuntimeConfig;
  ctx: ProviderRunContext;
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
  /** If set, image models are emitted with this channel type (native image
   *  surface). Omit to skip image models entirely. Cloudflare = CLOUDFLARE. */
  imageChannelType?: number;
  /** If set, audio models (STT/TTS) are emitted with this channel type. Omit to
   *  skip audio. Groq = OPENAI, Cloudflare = CLOUDFLARE. */
  audioChannelType?: number;
  /** If set, video models are emitted with this channel type. Omit to skip video.
   *  Bailian = ALI (17) DashScope video-synthesis. */
  videoChannelType?: number;
  /** Keep 429-failing models as working (Cloudflare neuron-cap: 429 = free model,
   *  budget spent, not broken). Only where 429 means capacity. */
  acceptRateLimited?: boolean;
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
  /** Glob patterns for models that are priced (canonical * (1+adjustment)) instead
   *  of forced-free. Their OfferModel.isFree is false so the pricing phase prices them. */
  paidModels?: string[];
  /** Upstream ids kept only via a 429 accept; their channels emit disabled. */
  rateLimited?: Set<string>;
}): UpstreamOffer[] {
  const offers: UpstreamOffer[] = [];
  const channelType = opts.channelType ?? CHANNEL_TYPES.OPENAI;
  const modelType = opts.modelType ?? "text";
  const paidModels = opts.paidModels ?? [];
  const rateLimited = opts.rateLimited ?? new Set<string>();
  const isPaid = (exposed: string) =>
    paidModels.length > 0 && matchesAnyPattern(exposed, paidModels);
  const byVendor = partitionByVendor(
    opts.resolutions,
    (x) => x.exposed,
    "other",
  );
  const toOfferModel = (x: Resolution): OfferModel => {
    const upstream = opts.rev[x.exposed] ?? x.upstream;
    const maxOut = opts.maxOutputByModel.get(upstream);
    return {
      exposed: x.exposed,
      upstream,
      modelType,
      isFree: !isPaid(x.exposed),
      ...(rateLimited.has(upstream) ? { rateLimited: true } : {}),
      testDetail: opts.details.find((d) => d.model === x.upstream),
      ...(opts.endpoints ? { endpoints: opts.endpoints } : {}),
      ...(maxOut ? { metadata: { maxOutputTokens: maxOut } } : {}),
    };
  };
  const buildOffer = (
    vendor: string,
    models: OfferModel[],
    freeTier: boolean,
  ): UpstreamOffer => ({
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
    models,
    isFreeTier: freeTier,
    priceAdjustment: opts.priceAdjustment,
    defaultAdjustment: 0,
  });
  for (const [vendor, vendorResolutions] of byVendor) {
    const all = vendorResolutions.map(toOfferModel);
    // Free + paid models are emitted as SEPARATE offers: a free offer routes to
    // phase-A $0; a paid offer (no free siblings) routes to phase-B canonical
    // pricing. Mixing them in one offer would pull the paid model into phase-A via
    // its free siblings' hasAny, pricing it at groupRatio*adj = 0.
    const free = all.filter((m) => m.isFree);
    const paid = all.filter((m) => !m.isFree);
    if (free.length > 0) offers.push(buildOffer(vendor, free, true));
    if (paid.length > 0) offers.push(buildOffer(vendor, paid, false));
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
    let typeHints: Map<string, ModelType> | undefined;
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
      typeHints = discovered.modelTypeHints;
      consola.info(
        t("CORE.PROVIDER.DISCOVERED_MODELS", { name, count: allModels.length }),
      );
    }
    const typeOf = (m: string): ModelType =>
      typeHints?.get(m) ?? inferModelType(m);
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
    if (opts.imageChannelType !== undefined)
      modalities.push({
        modelType: "image",
        channelType: opts.imageChannelType,
        endpoints: ["image-generation"],
      });
    if (opts.audioChannelType !== undefined)
      modalities.push({
        modelType: "audio",
        channelType: opts.audioChannelType,
        endpoints: ["audio"],
      });
    if (opts.videoChannelType !== undefined)
      modalities.push({
        modelType: "video",
        channelType: opts.videoChannelType,
        endpoints: ["openai-video"],
      });

    // Modalities the provider opted OUT of probing (config testModelTypes) are
    // emitted verbatim, unprobed. Needed for DashScope image/video: their task-API
    // shapes have no OpenAI-compatible probe (getImageTestConfig is OpenAI-only).
    const testable = getTestModelTypes(config, providerConfig);

    for (const modality of modalities) {
      const models = allModels.filter((m) => typeOf(m) === modality.modelType);
      if (models.length === 0) continue;

      if (!testable.has(modality.modelType)) {
        const resolutions = resolveBareNames(models, config.modelMapping);
        totalWorking += models.length;
        consola.info(
          t("CORE.NVIDIA.TEXT_WORKING", {
            name,
            working: models.length,
            total: models.length,
          }),
        );
        offers.push(
          ...emitFreeTextOffers({
            resolutions,
            rev: buildChannelModelMapping(resolutions),
            details: [],
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
            paidModels: providerConfig.paidModels,
          }),
        );
        continue;
      }
      // Probe each modality as itself (text -> chat, embedding -> /embeddings),
      // not via the text-only config default, so non-chat models are verified too.
      // modelEndpoints carries the modality's endpoint tag so the runner's own
      // inferModelType agrees (CF image models aren't image-named).
      const modelEndpoints = modality.endpoints
        ? new Map(models.map((m) => [m, modality.endpoints!]))
        : undefined;
      const r = await testAndFilterModels({
        allModels: models,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        channelType: modality.channelType,
        providerLabel: name,
        testableModelTypes: new Set([modality.modelType]),
        retryPolicy: opts.retryPolicy ?? NVIDIA_RETRY_POLICY,
        modelEndpoints,
        // acceptRateLimited keeps 429-failing models (chat throttling = capacity,
        // not breakage). Embeddings don't get that grace: a 429 or any failure on
        // /v1/embeddings means the model doesn't actually serve embeddings (dead,
        // reranker, wrong endpoint) -> drop it, never list it.
        acceptRateLimited:
          modality.modelType === "embedding" ? false : opts.acceptRateLimited,
        capabilities: buildCapabilityMap(models, mapExposed, ctx),
      });
      const working = r.workingModels;
      if (working.length === 0) continue;
      const rateLimited = new Set(r.rateLimitedModels);
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
          paidModels: providerConfig.paidModels,
          rateLimited,
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
