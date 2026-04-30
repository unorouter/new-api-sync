import { throwIfRunAborted } from "@core/runtime/abort";
import {
  getMetadataFromEnabledModels,
  getPricingGridFromEnabledModels,
  type RuntimeConfig,
} from "@core/config";
import {
  buildReverseMapping,
  ENDPOINT_DEFAULT_PATHS,
  getTaskModelOverride,
  inferModelType,
  inferVendorFromModelName,
  MODEL_TYPE_CANONICAL_ENDPOINT,
  normalizeEndpointType,
  parseModelList,
} from "@core/models/constants";
import {
  type BasellmEntry,
  buildMetadataMap,
  fetchBasellmEntries,
  fetchOpenRouterDescriptions,
} from "@core/models/metadata";
import {
  buildModelMetadata,
  deriveTagsFromMetadata,
  fetchAllPricingSources,
  type PricingSource,
  resolveBasePricing,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import { processDirectProvider } from "@core/providers/direct/provider";
import { NewApiClient } from "@core/providers/newapi/client";
import { processNewApiProvider } from "@core/providers/newapi/provider";
import { processNvidiaProvider } from "@core/providers/nvidia/provider";
import { processOpenRouterProvider } from "@core/providers/openrouter/provider";
import { processSub2ApiProvider } from "@core/providers/sub2api/provider";
import type {
  Channel,
  DesiredModelSpec,
  DesiredState,
  ManagedOptionMaps,
  ProviderReport,
  SyncState,
  TargetSnapshot,
} from "@core/types";
import type {
  DirectProviderConfig,
  NvidiaProviderConfig,
  OpenRouterProviderConfig,
  ProviderConfig,
  Sub2ApiProviderConfig,
} from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";

/**
 * Fill in base ratios from layered pricing sources (LiteLLM > OpenRouter >
 * basellm-canonical, first-match-wins). Channel-supplied ratios are the
 * source of truth (they reflect what your upstream actually charges YOU);
 * external sources are only used for models with no channel data, plus to
 * fill missing cache_ratio / create_cache_ratio fields.
 *
 * Per field, the precedence is:
 *   ratio / completionRatio:       channel > external (channel = your cost)
 *   cacheRatio / createCacheRatio: channel > external (channel preferred,
 *                                  external fills gaps when upstream
 *                                  doesn't expose cache pricing)
 *
 * Skipped:
 * - models with quotaType >= 1 (per-request / grid pricing — billing
 *   doesn't go through ratio path so model_ratio doesn't matter)
 * - models with explicit modelPrice > 0 (same)
 *
 * Group-ratio floor enforcement (preventing sales below upstream cost)
 * lives in buildPriceTiers, not here — it operates on per-tier group
 * ratios using each provider's own cheapest upstream group ratio.
 */
function resolveAllModelPricing(
  state: SyncState,
  channels: Channel[],
  modelMapping: Record<string, string>,
  sources: PricingSource[],
): void {
  const allModels = new Set<string>(state.mergedModels.keys());
  for (const ch of channels) {
    for (const m of parseModelList(ch.models)) allModels.add(m);
  }
  if (allModels.size === 0) return;

  const reverseMapping = buildReverseMapping(modelMapping);

  let backfilled = 0;
  let cacheFilled = 0;
  let skippedFixedPrice = 0;
  let missing = 0;
  const missingModels: string[] = [];

  for (const model of allModels) {
    const existing = state.mergedModels.get(model);

    // Skip models on per-request/grid pricing — ratio path is unused.
    if (
      existing &&
      ((existing.quotaType !== undefined && existing.quotaType >= 1) ||
        (existing.modelPrice !== undefined && existing.modelPrice > 0))
    ) {
      skippedFixedPrice++;
      continue;
    }

    const hit =
      sources.length > 0
        ? resolveBasePricing(model, sources, reverseMapping)
        : undefined;

    if (!existing && !hit) {
      missing++;
      missingModels.push(model);
      continue;
    }

    // Backfill case: no channel ratio, use external source.
    if (!existing && hit) {
      state.mergedModels.set(model, {
        ratio: hit.modelRatio,
        completionRatio: hit.completionRatio,
        cacheRatio: hit.cacheRatio,
        createCacheRatio: hit.createCacheRatio,
        pricingSource: hit.source,
      });
      backfilled++;
      consola.debug(
        `[pricing] backfill ${model} <- ${hit.source} (${hit.sourceKey}): ratio=${hit.modelRatio.toFixed(4)} completion=${hit.completionRatio.toFixed(2)}`,
      );
      continue;
    }

    // Channel-supplied case: keep channel ratios but fill cache from sources
    // if the upstream channel didn't expose cache pricing.
    if (!existing) continue;
    if (!hit) continue;

    if (existing.cacheRatio === undefined && hit.cacheRatio !== undefined) {
      existing.cacheRatio = hit.cacheRatio;
      cacheFilled++;
    }
    if (
      existing.createCacheRatio === undefined &&
      hit.createCacheRatio !== undefined
    ) {
      existing.createCacheRatio = hit.createCacheRatio;
    }
  }

  consola.info(
    `[pricing] ${allModels.size} model(s): ${backfilled} backfilled from sources, ${cacheFilled} cache filled, ${skippedFixedPrice} skipped (per-request), ${missing} unresolved`,
  );
  if (missingModels.length > 0) {
    const details = missingModels.map((m) => {
      const refs = channels
        .filter((ch) => parseModelList(ch.models).includes(m))
        .map((ch) => ch.tag ?? ch.name);
      return refs.length > 0 ? `${m} (${refs.join(", ")})` : m;
    });
    consola.warn(
      `[pricing] no source matched: ${details.join(", ")}`,
    );
  }
}

function buildOptionMaps(
  state: SyncState,
  modelMapping: Record<string, string>,
  configGridPricing: Record<string, Record<string, string | number>[]>,
): Omit<ManagedOptionMaps, "responsesApiModels" | "defaultUseAutoGroup"> {
  const groupRatio: Record<string, number> = {};
  const userUsableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)",
  };

  for (const group of state.mergedGroups) {
    groupRatio[group.name] = Math.round(group.ratio * 10000) / 10000;
    userUsableGroups[group.name] = group.description;
  }

  const autoGroups = [...state.mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((group) => group.name);

  const modelRatio: Record<string, number> = {};
  const completionRatio: Record<string, number> = {};
  const modelPrice: Record<string, number> = {};
  const imageRatio: Record<string, number> = {};
  const cacheRatio: Record<string, number> = {};
  const createCacheRatio: Record<string, number> = {};
  const modelQuotaType: Record<string, number> = {};
  for (const [name, ratios] of state.mergedModels) {
    const mappedName = modelMapping?.[name] ?? name;
    const isPerRequest =
      ratios.quotaType !== undefined && ratios.quotaType >= 1;
    if (
      (ratios.modelPrice !== undefined && ratios.modelPrice > 0) ||
      isPerRequest
    ) {
      modelPrice[mappedName] =
        Math.round((ratios.modelPrice ?? 0) * 10000) / 10000;
    } else {
      modelRatio[mappedName] = Math.round(ratios.ratio * 10000) / 10000;
      completionRatio[mappedName] =
        Math.round(ratios.completionRatio * 10000) / 10000;
    }
    if (ratios.imageRatio !== undefined && ratios.imageRatio > 0) {
      imageRatio[mappedName] = Math.round(ratios.imageRatio * 10000) / 10000;
    }
    if (ratios.cacheRatio !== undefined && ratios.cacheRatio >= 0) {
      cacheRatio[mappedName] = Math.round(ratios.cacheRatio * 10000) / 10000;
    }
    if (ratios.createCacheRatio !== undefined && ratios.createCacheRatio >= 0) {
      createCacheRatio[mappedName] =
        Math.round(ratios.createCacheRatio * 10000) / 10000;
    }
    if (ratios.quotaType !== undefined && ratios.quotaType >= 1) {
      modelQuotaType[mappedName] = ratios.quotaType;
    }
  }

  // Build grid pricing display metadata from config.
  // Grid pricing is independent of quota_type: video models use quota_type=4,
  // image models keep quota_type=1 (per-request) but still show a resolution grid.
  const modelGridPricing: Record<
    string,
    import("@core/types").GridPricingInfo
  > = {};
  for (const [modelName, rows] of Object.entries(configGridPricing)) {
    const mappedName = modelMapping?.[modelName] ?? modelName;
    if (
      modelPrice[mappedName] !== undefined ||
      modelRatio[mappedName] !== undefined
    ) {
      modelGridPricing[mappedName] =
        rows as import("@core/types").GridPricingInfo;
    }
  }

  return {
    groupRatio,
    userUsableGroups,
    autoGroups,
    modelRatio,
    completionRatio,
    modelPrice,
    imageRatio,
    cacheRatio,
    createCacheRatio,
    modelQuotaType,
    modelGridPricing,
  };
}

function buildDesiredModels(opts: {
  channels: Channel[];
  state: SyncState;
  reverseMapping: Map<string, string>;
  basellmEntries: BasellmEntry[];
  openRouterDescriptions: Map<string, string>;
  modelMapping: Record<string, string>;
  /**
   * Per-model metadata overrides collected from each provider's
   * `enabledModels`. Keyed by the UPSTREAM model id (e.g.
   * "z-ai/glm4.7"). Applied after the bare-name resolution so the
   * metadata lands on whichever exposed name the sync actually pushes.
   */
  metadataByUpstream: Record<string, Record<string, unknown>>;
  /** Pricing sources used to auto-populate model metadata (max tokens,
   *  capabilities, modalities). Override from enabledModels still wins. */
  pricingSources: PricingSource[];
}): Map<string, DesiredModelSpec> {
  const models = new Map<string, DesiredModelSpec>();

  for (const channel of opts.channels) {
    const channelModels = parseModelList(channel.models);
    for (const modelName of channelModels) {
      const vendor = inferVendorFromModelName(modelName);
      const originalEps =
        opts.state.modelOriginalEndpoints.get(modelName) ??
        opts.state.modelOriginalEndpoints.get(
          opts.reverseMapping.get(modelName) ?? "",
        );
      let endpoints: string | undefined;
      if (originalEps) {
        const epMap: Record<string, string> = {};
        for (const origEp of originalEps) {
          const normalized = normalizeEndpointType(origEp);
          const info = opts.state.endpointPaths.get(origEp);
          const path = info?.path ?? ENDPOINT_DEFAULT_PATHS[normalized];
          if (path) epMap[normalized] = path;
        }
        if (Object.keys(epMap).length > 0) endpoints = JSON.stringify(epMap);
      } else {
        // No upstream endpoint data: infer from model type
        const modelType = inferModelType(modelName);
        const canonicalEp = MODEL_TYPE_CANONICAL_ENDPOINT[modelType];
        if (canonicalEp) {
          const path = ENDPOINT_DEFAULT_PATHS[canonicalEp];
          if (path) endpoints = JSON.stringify({ [canonicalEp]: path });
        }
      }
      models.set(modelName, {
        model_name: modelName,
        vendor,
        endpoints,
      });
    }
  }

  // Enrich models with descriptions (OpenRouter) and tags (basellm)
  const metadataMap = buildMetadataMap({
    modelNames: models.keys(),
    basellmEntries: opts.basellmEntries,
    openRouterDescriptions: opts.openRouterDescriptions,
    modelMapping: opts.modelMapping,
  });
  for (const [modelName, meta] of metadataMap) {
    const existing = models.get(modelName);
    if (existing) {
      if (meta.description) existing.description = meta.description;
      if (meta.tags) existing.tags = meta.tags;
    }
  }

  // Add model type tag (and a `Task` tag for async task models) and deduplicate.
  // The `Task` tag lets downstream consumers (unorouter) tell async task models
  // apart from regular streaming models without re-encoding the override list.
  // Gate `Task` on the upstream actually exposing `openai-video`; a name like
  // `grok-imagine-video` can also be resold as chat-completions, in which case
  // it is not a task model for this channel.
  //
  // Tags are merged from three sources, in order of precedence:
  // 1. Type prefix (Text/Image/Video/Audio + optional Task)
  // 2. basellm tags (already in spec.tags from buildMetadataMap)
  // 3. Capability tags derived from LiteLLM/OpenRouter metadata
  //    (Reasoning, Tools, Vision, Audio, Files, Cache, WebSearch, ComputerUse,
  //    + context-window tag like "200K", "1M")
  for (const [modelName, spec] of models) {
    const originalName = opts.reverseMapping.get(modelName) ?? modelName;
    const eps =
      opts.state.modelEndpoints.get(modelName) ??
      opts.state.modelEndpoints.get(originalName);
    const modelType = inferModelType(modelName, eps);
    const typeTag = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const isTaskModel =
      eps?.includes("openai-video") ||
      (!eps && getTaskModelOverride(modelName) !== undefined);
    const prefix = isTaskModel ? `${typeTag},Task` : typeTag;

    const sourceMd = resolveSourceMetadata(
      modelName,
      opts.pricingSources,
      opts.reverseMapping,
    );
    const sourceTags = deriveTagsFromMetadata(sourceMd);

    const rawTags = [
      prefix,
      spec.tags ?? "",
      sourceTags.join(","),
    ]
      .filter(Boolean)
      .join(",");

    const seen = new Set<string>();
    const deduped = rawTags
      .split(",")
      .map((t: string) => t.trim())
      .filter((t: string) => {
        if (!t) return false;
        const lower = t.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      })
      .join(",");
    spec.tags =
      deduped.length > 255
        ? deduped.slice(0, deduped.lastIndexOf(",", 255) || 255)
        : deduped;
  }

  // Apply per-model metadata. Layered: source-derived (LiteLLM > OpenRouter
  // > basellm) provides defaults, then per-model `enabledModels[].metadata`
  // overrides win. Config keys are the upstream id (`z-ai/glm4.7`); desired
  // models are keyed by the exposed bare name (`glm4.7`). Build exposed ->
  // upstream from each channel's model_mapping since that's the real source
  // of bare-name resolution (global reverseMapping only covers
  // config.modelMapping renames).
  const exposedToUpstream = new Map<string, string>();
  for (const ch of opts.channels) {
    if (!ch.model_mapping) continue;
    try {
      const mm = JSON.parse(ch.model_mapping) as Record<string, string>;
      for (const [exposed, upstream] of Object.entries(mm)) {
        exposedToUpstream.set(exposed, upstream);
      }
    } catch {
      // malformed model_mapping — skip
    }
  }
  for (const [modelName, spec] of models) {
    const upstream = exposedToUpstream.get(modelName) ?? modelName;
    const override =
      opts.metadataByUpstream[upstream] ?? opts.metadataByUpstream[modelName];
    const merged = buildModelMetadata({
      modelName,
      sources: opts.pricingSources,
      reverseMapping: opts.reverseMapping,
      override,
    });
    if (merged) {
      spec.metadata = JSON.stringify(merged);
    }
  }

  return models;
}

function collectResponsesApiModels(
  channels: Channel[],
  state: SyncState,
  reverseMapping: Map<string, string>,
  modelMapping: Record<string, string>,
): string[] {
  const result: string[] = [];
  for (const channel of channels) {
    for (const modelName of parseModelList(channel.models)) {
      const mappedName = modelMapping?.[modelName] ?? modelName;
      const originalName = reverseMapping.get(mappedName) ?? mappedName;
      const eps =
        state.modelEndpoints.get(modelName) ??
        state.modelEndpoints.get(originalName);
      if (eps?.includes("openai-response")) {
        result.push(mappedName);
      }
    }
  }
  return result;
}

export async function runProviderPipeline(
  config: RuntimeConfig,
  targetSnapshot?: TargetSnapshot,
): Promise<{ desired: DesiredState; providerReports: ProviderReport[] }> {
  const state: SyncState = {
    mergedGroups: [],
    mergedModels: new Map(),
    modelEndpoints: new Map(),
    modelOriginalEndpoints: new Map(),
    endpointPaths: new Map(),
    channelsToCreate: [],
    canonicalRatios: new Map(),
    canonicalLookup: () => undefined,
  };

  // Seed state with baseline channels/groups from the target so that
  // providers like sub2api can see prices from providers not in this run
  // (critical for --only partial syncs).
  const managedProviders = new Set(config.providers.map((p) => p.name));
  if (targetSnapshot) {
    // For partial sync, fetch the pricing API for accurate ratios and model data.
    // For full sync, fall back to GroupRatio from the snapshot.
    let pricingGroupRatio = new Map<string, number>();
    let snapshotGroupRatio: Record<string, number> = {};
    let targetPricing:
      | Awaited<ReturnType<NewApiClient["fetchPricing"]>>
      | undefined;

    if (config.onlyProviders) {
      const targetClient = new NewApiClient(config.target, "target");
      targetPricing = await targetClient.fetchPricing();
      pricingGroupRatio = new Map(
        targetPricing.groups.map((g) => [g.name, g.ratio]),
      );
    }
    try {
      const raw = targetSnapshot.options["GroupRatio"];
      if (raw) snapshotGroupRatio = JSON.parse(raw);
    } catch {}

    // Seed ALL non-managed channels so buildPriceTiers can find
    // the cheapest existing group ratio for every model.
    const seededGroups = new Set<string>();
    for (const ch of targetSnapshot.channels) {
      if (ch.tag && managedProviders.has(ch.tag)) continue;
      state.channelsToCreate.push(ch);

      if (!seededGroups.has(ch.group)) {
        seededGroups.add(ch.group);
        const ratio =
          pricingGroupRatio.get(ch.group) ?? snapshotGroupRatio[ch.group] ?? 1;
        state.mergedGroups.push({
          name: ch.group,
          ratio,
          description: `baseline: ${ch.group}`,
          provider: ch.tag ?? "__baseline__",
        });
      }
    }

    // Partial sync: also add pricing-only groups and seed model ratios
    if (targetPricing) {
      for (const group of targetPricing.groups) {
        if (seededGroups.has(group.name)) continue;
        state.mergedGroups.push({
          name: group.name,
          ratio: group.ratio,
          description: group.description,
          provider: "__baseline__",
        });
      }

      for (const model of targetPricing.models) {
        if (!state.mergedModels.has(model.name)) {
          state.mergedModels.set(model.name, {
            ratio: model.ratio,
            completionRatio: model.completionRatio ?? 1,
            modelPrice: model.modelPrice,
          });
        }
      }
    }

    consola.debug(
      t("CORE.PIPELINE.BASELINE_SEEDED", {
        channels: state.channelsToCreate.length,
        groups: state.mergedGroups.length,
      }),
    );
    for (const g of state.mergedGroups) {
      consola.debug(
        t("CORE.PIPELINE.BASELINE_GROUP", {
          name: g.name,
          ratio: g.ratio.toFixed(4),
          provider: g.provider,
        }),
      );
    }
  }
  const baselineChannelCount = state.channelsToCreate.length;
  const baselineGroupCount = state.mergedGroups.length;

  // Fetch metadata + pricing sources up front: providers' tier-cap logic needs
  // canonical retail ratios at channel-build time. basellm is shared between
  // description/tags enrichment (buildMetadataMap) and the canonical-vendor
  // pricing source (resolver) — fetched once, used twice.
  const [basellmEntries, openRouterDescriptions] = await Promise.all([
    fetchBasellmEntries(),
    fetchOpenRouterDescriptions(),
  ]);
  const pricingSources = await fetchAllPricingSources(basellmEntries);

  // Wire lazy canonical lookup. Providers call state.canonicalLookup(model)
  // during channel construction to compare upstream effective price against
  // retail. Caches per-model so repeat lookups are O(1).
  const reverseMappingForCanon = buildReverseMapping(config.modelMapping);
  state.canonicalLookup = (model: string): number | undefined => {
    if (state.canonicalRatios.has(model)) {
      return state.canonicalRatios.get(model);
    }
    const hit = resolveBasePricing(model, pricingSources, reverseMappingForCanon);
    if (hit) {
      state.canonicalRatios.set(model, hit.modelRatio);
      return hit.modelRatio;
    }
    return undefined;
  };

  // Process providers (newapi first, then direct, then sub2api last)
  const typeOrder: Record<string, number> = {
    newapi: 0,
    nvidia: 1,
    openrouter: 2,
    direct: 3,
    sub2api: 4,
  };
  const sorted = [...config.providers].sort(
    (a, b) => (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2),
  );
  const providerReports: ProviderReport[] = [];
  for (const [i, provider] of sorted.entries()) {
    throwIfRunAborted();
    if (i > 0) console.log();
    let report: ProviderReport;
    if (provider.type === "newapi") {
      report = await processNewApiProvider(
        provider as ProviderConfig,
        config,
        state,
      );
    } else if (provider.type === "nvidia") {
      report = await processNvidiaProvider(
        provider as NvidiaProviderConfig,
        config,
        state,
      );
    } else if (provider.type === "openrouter") {
      report = await processOpenRouterProvider(
        provider as OpenRouterProviderConfig,
        config,
        state,
      );
    } else if (provider.type === "direct") {
      report = await processDirectProvider(
        provider as DirectProviderConfig,
        config,
        state,
      );
    } else {
      report = await processSub2ApiProvider(
        provider as Sub2ApiProviderConfig,
        config,
        state,
      );
    }
    providerReports.push(report);
  }

  // Strip baseline entries — they were only needed for buildPriceTiers()
  state.channelsToCreate = state.channelsToCreate.slice(baselineChannelCount);
  state.mergedGroups = state.mergedGroups.slice(baselineGroupCount);

  // Detect channel-name collisions. With vendor-split sub-grouping, two
  // independent producers (e.g. two upstream groups whose sanitized names both
  // produce `aigc-deepseek`) would silently overwrite each other. That hides
  // routing bugs, so collisions are now hard errors. If you see this thrown,
  // make the producer prefix more specific.
  const channelByName = new Map<string, Channel>();
  for (const ch of state.channelsToCreate) {
    const existing = channelByName.get(ch.name);
    if (existing) {
      throw new Error(
        `Channel name collision: "${ch.name}" produced twice ` +
          `(tags: ${existing.tag ?? "?"} and ${ch.tag ?? "?"}). ` +
          `Each (provider, group, vendor, ratio-tier, base-url-suffix) bucket ` +
          `must produce a unique channel name.`,
      );
    }
    channelByName.set(ch.name, ch);
  }
  const channels = [...channelByName.values()];

  // pricingSources / basellmEntries / openRouterDescriptions are pre-fetched
  // above so providers can use canonical ratios at channel-build time via
  // state.canonicalLookup.

  // Replace channel-seeded ratios with multi-source resolver values.
  // Priority: LiteLLM > OpenRouter > basellm-canonical. We are the source of
  // truth: upstream provider channels rely on whatever default ratios we
  // write here. See plan: source-pros-cons-openrouter-lexical-twilight.md
  resolveAllModelPricing(state, channels, config.modelMapping, pricingSources);

  // Collect pricing grid data from all providers' enabledModels
  const allPricingGrids: Record<string, Record<string, string | number>[]> = {};
  for (const provider of config.providers) {
    const grids = getPricingGridFromEnabledModels(provider.enabledModels);
    Object.assign(allPricingGrids, grids);
  }

  // Collect per-model metadata overrides from all providers' enabledModels.
  // Keyed by upstream id (e.g. "z-ai/glm4.7"); applied post-bare-name resolution.
  const allMetadata: Record<string, Record<string, unknown>> = {};
  for (const provider of config.providers) {
    const metadata = getMetadataFromEnabledModels(provider.enabledModels);
    Object.assign(allMetadata, metadata);
  }

  const optionMaps = buildOptionMaps(
    state,
    config.modelMapping,
    allPricingGrids,
  );

  const reverseMapping = buildReverseMapping(config.modelMapping);

  const models = buildDesiredModels({
    channels,
    state,
    reverseMapping,
    basellmEntries,
    openRouterDescriptions,
    modelMapping: config.modelMapping,
    metadataByUpstream: allMetadata,
    pricingSources,
  });

  const responsesApiModels = collectResponsesApiModels(
    channels,
    state,
    reverseMapping,
    config.modelMapping,
  );

  return {
    providerReports,
    desired: {
      channels,
      models,
      options: {
        ...optionMaps,
        defaultUseAutoGroup: true,
        responsesApiModels: [...new Set(responsesApiModels)],
      },
      managedProviders: new Set([
        ...config.providers.map((provider) => provider.name),
        // During full syncs, also claim ownership of channels tagged by
        // providers that were previously synced but are no longer in config,
        // so their channels/models get cleaned up.
        ...(targetSnapshot && !config.onlyProviders
          ? targetSnapshot.channels.filter((ch) => ch.tag).map((ch) => ch.tag!)
          : []),
      ]),
      mappingSources: new Set(Object.keys(config.modelMapping)),
    },
  };
}
