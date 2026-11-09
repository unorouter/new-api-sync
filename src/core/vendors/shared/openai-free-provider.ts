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
import {
  getMetadataFromEnabledModels,
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
import type { ModelType, ProviderReport } from "@core/types";
import type {
  ModelMetadata,
  OpenAICompatibleProviderConfig,
} from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import {
  collapseEffortVariants,
  type EffortFamily,
} from "../newapi/effort-variants";
import { buildCapabilityMap, passthroughExposed } from "./capability-map";
import { discoverModels } from "./generic-discovery";
import { partitionByVendor } from "./partition";

export interface OpenAIFreeDiscovery {
  models: string[];
  /** upstream model id -> documented max output tokens. */
  maxOutputByModel: Map<string, number>;
  /** Authoritative modality per model when the provider catalog declares it
   *  (e.g. Cloudflare's task). Overrides name-based inferModelType. */
  modelTypeHints?: Map<string, ModelType>;
  /** upstream model id -> real input cost as a new-api ratio (ratio 1 == $2/M).
   *  Only PAID providers (DeepInfra) populate this; it becomes the upstreamRatio
   *  of paid OfferModels so their retail tracks the actual upstream cost. */
  ratioByModel?: Map<string, number>;
  /** upstream model id -> completion/input cost multiplier. */
  completionRatioByModel?: Map<string, number>;
}

export interface OpenAIFreeOpts {
  providerConfig: OpenAICompatibleProviderConfig;
  config: RuntimeConfig;
  ctx: ProviderRunContext;
}

type Resolution = ReturnType<typeof resolveBareNames>[number];

/** Emit one free UpstreamOffer per inferred vendor. Reusable by nvidia text + openrouter free branches. */
function emitFreeTextOffers(opts: {
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
  /** Glob patterns for models that are priced (applyPriceAdjustment toward the
   *  canonical ceiling) instead of forced-free. Their OfferModel.isFree is false
   *  so the pricing phase prices them. */
  paidModels?: string[];
  /** Upstream ids kept only via a 429 accept; their channels emit disabled. */
  rateLimited?: Set<string>;
  /** Per-model metadata from config enabledModels (glob key -> metadata), merged
   *  onto each matching OfferModel. Carries disableThinking, maxOutputTokens, etc. */
  metadataByModel?: Record<string, ModelMetadata>;
  /** upstream id -> real input cost ratio; sets upstreamRatio on PAID models so
   *  their retail prices off actual upstream cost (DeepInfra). */
  ratioByModel?: Map<string, number>;
  /** upstream id -> completion/input multiplier for paid models. */
  completionRatioByModel?: Map<string, number>;
  /** channel param_override JSON set on every OfferModel (kind-wide). */
  paramOverride?: string;
  /** Exposed glob to the name that lane publishes under (provider config `publishAs`). */
  publishAs?: Record<string, string>;
  /** Stand-in upstream id -> its effort family (provider config `collapseEfforts`). */
  effortFamilies?: Map<string, EffortFamily>;
}): UpstreamOffer[] {
  const offers: UpstreamOffer[] = [];
  const channelType = opts.channelType ?? CHANNEL_TYPES.OPENAI;
  const modelType = opts.modelType ?? "text";
  const paidModels = opts.paidModels ?? [];
  const rateLimited = opts.rateLimited ?? new Set<string>();
  const metadataGlobs = Object.entries(opts.metadataByModel ?? {});
  const configMetadataFor = (exposed: string): ModelMetadata | undefined => {
    for (const [glob, meta] of metadataGlobs) {
      if (exposed === glob || matchesAnyPattern(exposed, [glob])) return meta;
    }
    return undefined;
  };
  const isPaid = (exposed: string) =>
    paidModels.length > 0 && matchesAnyPattern(exposed, paidModels);
  const publishAsFor = (exposed: string): string | undefined =>
    Object.entries(opts.publishAs ?? {}).find(([glob]) =>
      matchesAnyPattern(exposed, [glob]),
    )?.[1];
  const byVendor = partitionByVendor(
    opts.resolutions,
    (x) => x.exposed,
    "other",
  );
  const toOfferModel = (x: Resolution): OfferModel => {
    const upstream = opts.rev[x.exposed] ?? x.upstream;
    const family = opts.effortFamilies?.get(x.upstream);
    const publishAs = publishAsFor(x.exposed) ?? family?.base;
    const maxOut = opts.maxOutputByModel.get(upstream);
    const configMeta = configMetadataFor(x.exposed);
    const metadata: ModelMetadata = {
      ...(maxOut ? { maxOutputTokens: maxOut } : {}),
      ...configMeta,
    };
    const paid = isPaid(x.exposed);
    // Paid lanes carry the real upstream cost (keyed by the raw discovery id, which
    // is x.upstream here) so pricing tracks actual cost instead of a $2/M default.
    const upstreamRatio = paid ? opts.ratioByModel?.get(x.upstream) : undefined;
    const upstreamCompletionRatio = paid
      ? opts.completionRatioByModel?.get(x.upstream)
      : undefined;
    return {
      exposed: x.exposed,
      upstream,
      modelType,
      isFree: !paid,
      ...(upstreamRatio !== undefined ? { upstreamRatio } : {}),
      ...(upstreamCompletionRatio !== undefined
        ? { upstreamCompletionRatio }
        : {}),
      ...(rateLimited.has(upstream) ? { rateLimited: true } : {}),
      testDetail: opts.details.find((d) => d.model === x.upstream),
      ...(opts.endpoints ? { endpoints: opts.endpoints } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
      ...(opts.paramOverride ? { paramOverride: opts.paramOverride } : {}),
      ...(publishAs ? { publishAs } : {}),
      ...(family ? { effortVariants: family.variants } : {}),
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
  const label = providerConfig.label ?? name;
  const paramOverride = providerConfig.paramOverride
    ? JSON.stringify(providerConfig.paramOverride)
    : undefined;
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
    let ratioByModel: Map<string, number> | undefined;
    let completionRatioByModel: Map<string, number> | undefined;
    if (providerConfig.models?.length) {
      allModels = providerConfig.models;
      consola.info(
        t("CORE.PROVIDER.USING_EXPLICIT_MODELS", {
          name,
          count: allModels.length,
        }),
      );
    } else {
      const discovered = await discoverModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
        label,
        providerConfig.discovery,
      );
      allModels = discovered.models;
      maxOutputByModel = discovered.maxOutputByModel;
      typeHints = discovered.modelTypeHints;
      ratioByModel = discovered.ratioByModel;
      completionRatioByModel = discovered.completionRatioByModel;
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
    let effortFamilies: Map<string, EffortFamily> | undefined;
    if (providerConfig.collapseEfforts) {
      const collapsed = collapseEffortVariants(allModels, () => "free");
      allModels = collapsed.models;
      effortFamilies = collapsed.families;
    }

    const channelType = providerConfig.channelType ?? CHANNEL_TYPES.OPENAI;
    const mapExposed = passthroughExposed(config);
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
    if (providerConfig.imageChannelType !== undefined)
      modalities.push({
        modelType: "image",
        channelType: providerConfig.imageChannelType,
        endpoints: ["image-generation"],
      });
    if (providerConfig.audioChannelType !== undefined)
      modalities.push({
        modelType: "audio",
        channelType: providerConfig.audioChannelType,
        endpoints: ["audio"],
      });
    if (providerConfig.videoChannelType !== undefined)
      modalities.push({
        modelType: "video",
        channelType: providerConfig.videoChannelType,
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
            providerKind: providerConfig.type,
            sanitizedBase: sanitizeGroupName(name),
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            groupRatio: providerConfig.ratio,
            channelRemark: `${label} via ${name}`,
            priceAdjustment: providerConfig.priceAdjustment,
            channelType: modality.channelType,
            modelType: modality.modelType,
            endpoints: modality.endpoints,
            paidModels: providerConfig.paidModels,
            ratioByModel,
            completionRatioByModel,
            paramOverride: paramOverride,
            publishAs: providerConfig.publishAs,
            effortFamilies,
            metadataByModel: getMetadataFromEnabledModels(
              providerConfig.enabledModels,
            ),
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
        retryPolicy: NVIDIA_RETRY_POLICY,
        modelEndpoints,
        // acceptRateLimited keeps 429-failing models (chat throttling = capacity,
        // not breakage). Embeddings don't get that grace: a 429 or any failure on
        // /v1/embeddings means the model doesn't actually serve embeddings (dead,
        // reranker, wrong endpoint) -> drop it, never list it.
        acceptRateLimited:
          modality.modelType === "embedding"
            ? false
            : (providerConfig.acceptRateLimited ?? false),
        skipAuthenticity: providerConfig.skipAuthenticity ?? false,
        // Resellers bill like the marketplaces, so a hidden injected prompt or a
        // fanned-out request shows up the same way.
        usageTruth: (providerConfig.paidModels?.length ?? 0) > 0,
        capabilities: buildCapabilityMap(models, mapExposed, ctx),
        ...(providerConfig.probeBody
          ? { extraBody: providerConfig.probeBody }
          : {}),
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
          providerKind: providerConfig.type,
          sanitizedBase: sanitizeGroupName(name),
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          groupRatio: providerConfig.ratio,
          channelRemark: `${label} via ${name}`,
          priceAdjustment: providerConfig.priceAdjustment,
          channelType: modality.channelType,
          modelType: modality.modelType,
          endpoints: modality.endpoints,
          paidModels: providerConfig.paidModels,
          ratioByModel,
          completionRatioByModel,
          paramOverride: paramOverride,
          publishAs: providerConfig.publishAs,
          effortFamilies,
          metadataByModel: getMetadataFromEnabledModels(
            providerConfig.enabledModels,
          ),
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
