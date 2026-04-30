import { throwIfRunAborted } from "@core/runtime/abort";
import { ConcurrencyGate, setConcurrencyGate } from "@core/runtime/semaphore";
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
import { computePricedPlan } from "@core/pricing/compute";
import { emitChannels } from "@core/pricing/emit";
import type { UpstreamOffer } from "@core/pricing/offers";
import {
  buildModelMetadata,
  deriveTagsFromMetadata,
  fetchAllPricingSources,
  type PricingSource,
  resolveBasePricing,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import type { BaselineInputs } from "@core/pricing/types";
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
  MergedGroup,
  MergedModel,
  ProviderReport,
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

// Pricing math (canonical override, rescale, cap drops, free clobber-skip,
// OpenRouter paid bucketing, sub2api/direct cheapest-existing lookup) lives
// in src/core/pricing/compute.ts. The orchestration below collects offers
// from each provider, resolves canonical retail ratios up front, then calls
// computePricedPlan + emitChannels to produce the final state.

function buildOptionMaps(
  mergedGroups: MergedGroup[],
  mergedModels: Map<string, MergedModel>,
  modelMapping: Record<string, string>,
  configGridPricing: Record<string, Record<string, string | number>[]>,
): Omit<ManagedOptionMaps, "responsesApiModels" | "defaultUseAutoGroup"> {
  const groupRatio: Record<string, number> = {};
  const userUsableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)",
  };

  for (const group of mergedGroups) {
    groupRatio[group.name] = Math.round(group.ratio * 10000) / 10000;
    userUsableGroups[group.name] = group.description;
  }

  const autoGroups = [...mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((group) => group.name);

  const modelRatio: Record<string, number> = {};
  const completionRatio: Record<string, number> = {};
  const modelPrice: Record<string, number> = {};
  const imageRatio: Record<string, number> = {};
  const cacheRatio: Record<string, number> = {};
  const createCacheRatio: Record<string, number> = {};
  const modelQuotaType: Record<string, number> = {};
  for (const [name, ratios] of mergedModels) {
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
  /** Original upstream endpoint type strings, keyed by both `exposed` and
   *  `upstream` for each OfferModel. Replaces SyncState.modelOriginalEndpoints. */
  originalEndpointsByName: Map<string, string[]>;
  /** Normalized endpoint type strings, keyed by both `exposed` and `upstream`.
   *  Replaces SyncState.modelEndpoints. */
  normalizedEndpointsByName: Map<string, string[]>;
  /** Endpoint type -> {path, method} aggregated across all providers.
   *  Replaces SyncState.endpointPaths. */
  endpointPaths: Map<string, { path: string; method: string }>;
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
        opts.originalEndpointsByName.get(modelName) ??
        opts.originalEndpointsByName.get(
          opts.reverseMapping.get(modelName) ?? "",
        );
      let endpoints: string | undefined;
      if (originalEps) {
        const epMap: Record<string, string> = {};
        for (const origEp of originalEps) {
          const normalized = normalizeEndpointType(origEp);
          const info = opts.endpointPaths.get(origEp);
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
      opts.normalizedEndpointsByName.get(modelName) ??
      opts.normalizedEndpointsByName.get(originalName);
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
  normalizedEndpointsByName: Map<string, string[]>,
  reverseMapping: Map<string, string>,
  modelMapping: Record<string, string>,
): string[] {
  const result: string[] = [];
  for (const channel of channels) {
    for (const modelName of parseModelList(channel.models)) {
      const mappedName = modelMapping?.[modelName] ?? modelName;
      const originalName = reverseMapping.get(mappedName) ?? mappedName;
      const eps =
        normalizedEndpointsByName.get(modelName) ??
        normalizedEndpointsByName.get(originalName);
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
  // Initialise the shared concurrency gate. Per-upstream overrides are keyed
  // by baseUrl so testModels / probe code can look them up without knowing
  // the provider name.
  const overrides = new Map<string, number>();
  for (const p of config.providers) {
    if ("baseUrl" in p && p.baseUrl && p.perUpstreamConcurrency) {
      overrides.set(p.baseUrl, p.perUpstreamConcurrency);
    }
  }
  setConcurrencyGate(
    new ConcurrencyGate({
      globalLimit: config.globalConcurrency,
      perUpstreamLimit: config.perUpstreamConcurrency,
      overrides,
    }),
  );

  // Build BaselineInputs from the target snapshot. Pricing computation needs
  // these so partial-sync (--only) and sub2api/direct's "cheapest existing
  // group ratio" lookup can see what other (non-managed) channels exist.
  const managedProviders = new Set(config.providers.map((p) => p.name));
  const baseline: BaselineInputs = {
    groups: [],
    channels: [],
    modelRatios: new Map(),
  };

  if (targetSnapshot) {
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

    const seededGroups = new Set<string>();
    for (const ch of targetSnapshot.channels) {
      if (ch.tag && managedProviders.has(ch.tag)) continue;
      baseline.channels.push(ch);

      if (!seededGroups.has(ch.group)) {
        seededGroups.add(ch.group);
        const ratio =
          pricingGroupRatio.get(ch.group) ?? snapshotGroupRatio[ch.group] ?? 1;
        baseline.groups.push({
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
        baseline.groups.push({
          name: group.name,
          ratio: group.ratio,
          description: group.description,
          provider: "__baseline__",
        });
      }
      for (const model of targetPricing.models) {
        if (!baseline.modelRatios.has(model.name)) {
          baseline.modelRatios.set(model.name, {
            ratio: model.ratio,
            completionRatio: model.completionRatio ?? 1,
            modelPrice: model.modelPrice,
          });
        }
      }
    }

    consola.debug(
      t("CORE.PIPELINE.BASELINE_SEEDED", {
        channels: baseline.channels.length,
        groups: baseline.groups.length,
      }),
    );
    for (const g of baseline.groups) {
      consola.debug(
        t("CORE.PIPELINE.BASELINE_GROUP", {
          name: g.name,
          ratio: g.ratio.toFixed(4),
          provider: g.provider,
        }),
      );
    }
  }

  // Fetch metadata + pricing sources up front. Used for canonical retail
  // resolution AND for description/tags enrichment in buildDesiredModels.
  const [basellmEntries, openRouterDescriptions] = await Promise.all([
    fetchBasellmEntries(),
    fetchOpenRouterDescriptions(),
  ]);
  const pricingSources = await fetchAllPricingSources(basellmEntries);
  const reverseMappingForCanon = buildReverseMapping(config.modelMapping);

  // Process providers in order. Each returns its offers + a report.
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
  // All providers run concurrently. The shared ConcurrencyGate (keyed on
  // baseUrl) caps simultaneous requests per upstream, so opening up the
  // outer loop is safe. typeOrder still drives provider sort here so the
  // returned providerReports stay in deterministic order regardless of
  // completion order.
  const providerReports: ProviderReport[] = [];
  const allOffers: UpstreamOffer[] = [];

  const settled = await Promise.all(
    sorted.map((provider) => {
      throwIfRunAborted();
      if (provider.type === "newapi") {
        return processNewApiProvider(provider as ProviderConfig, config);
      }
      if (provider.type === "nvidia") {
        return processNvidiaProvider(
          provider as NvidiaProviderConfig,
          config,
        );
      }
      if (provider.type === "openrouter") {
        return processOpenRouterProvider(
          provider as OpenRouterProviderConfig,
          config,
        );
      }
      if (provider.type === "direct") {
        return processDirectProvider(
          provider as DirectProviderConfig,
          config,
        );
      }
      return processSub2ApiProvider(
        provider as Sub2ApiProviderConfig,
        config,
      );
    }),
  );

  // Aggregate per-provider endpoint metadata into single maps. Sorted-order
  // merge mirrors the pre-refactor behaviour where the last provider wins
  // on collision (deterministic across runs since `sorted` is stable).
  const aggregatedEndpointPaths = new Map<
    string,
    { path: string; method: string }
  >();
  const originalEndpointsByName = new Map<string, string[]>();
  const normalizedEndpointsByName = new Map<string, string[]>();
  for (const result of settled) {
    providerReports.push(result.report);
    allOffers.push(...result.offers);
    for (const [k, v] of result.endpointMetadata.endpointPaths) {
      aggregatedEndpointPaths.set(k, v);
    }
    for (const offer of result.offers) {
      for (const m of offer.models) {
        if (m.endpoints?.length) {
          originalEndpointsByName.set(m.exposed, m.endpoints);
          originalEndpointsByName.set(m.upstream, m.endpoints);
        }
        if (m.normalizedEndpoints?.length) {
          normalizedEndpointsByName.set(m.exposed, m.normalizedEndpoints);
          normalizedEndpointsByName.set(m.upstream, m.normalizedEndpoints);
        }
      }
    }
  }

  // Build the canonical retail map up front (one lookup per unique exposed
  // model across all offers + baseline). Compute uses this for canonical
  // override and cap-ceiling decisions.
  //
  // Auto-detect "canonical is wrong" outliers: if EVERY upstream offering a
  // model charges far above canonical retail (cheapest upstream_ratio still
  // exceeds canonical × maxRatioCap), then canonical is the outlier — its
  // value would drop the model from every tier despite all upstreams
  // agreeing on a much higher real price. In that case we replace canonical
  // with the cheapest upstream_ratio so the rescale base and cap ceiling
  // both rise proportionally; upstreams pricing this model above 1x land
  // naturally instead of being dropped.
  //
  // This typically catches kimi/deepseek/glm where LiteLLM/OpenRouter/
  // basellm understate market price. Models with only one upstream offer
  // get the same treatment (no consensus to argue against).
  const canonical = new Map<string, number>();
  const seenModels = new Set<string>();
  const upstreamRatiosByModel = new Map<string, number[]>();
  for (const offer of allOffers) {
    for (const m of offer.models) {
      seenModels.add(m.exposed);
      if (m.upstreamRatio !== undefined && m.upstreamRatio > 0) {
        let arr = upstreamRatiosByModel.get(m.exposed);
        if (!arr) {
          arr = [];
          upstreamRatiosByModel.set(m.exposed, arr);
        }
        arr.push(m.upstreamRatio);
      }
    }
  }
  for (const m of baseline.modelRatios.keys()) seenModels.add(m);

  let autoOverrides = 0;
  for (const m of seenModels) {
    const hit = resolveBasePricing(m, pricingSources, reverseMappingForCanon);
    const upstreamRatios = upstreamRatiosByModel.get(m);
    if (hit && upstreamRatios && upstreamRatios.length > 0) {
      const cheapestUpstream = Math.min(...upstreamRatios);
      const ceiling = hit.modelRatio * config.maxRatioCap;
      // Every upstream charges above canonical × cap → canonical is the outlier.
      if (cheapestUpstream > ceiling) {
        canonical.set(m, cheapestUpstream);
        autoOverrides++;
        consola.debug(
          `[pricing] canonical-outlier ${m}: canonical=${hit.modelRatio.toFixed(4)} ` +
            `cheapest_upstream=${cheapestUpstream.toFixed(4)} ` +
            `(>${config.maxRatioCap}x); using upstream as base`,
        );
        continue;
      }
    }
    if (hit) canonical.set(m, hit.modelRatio);
  }
  if (autoOverrides > 0) {
    consola.info(
      `[pricing] ${autoOverrides} model(s) auto-overrode canonical (every upstream above cap)`,
    );
  }

  // Compute the priced plan and emit it as concrete state.
  const plan = computePricedPlan({
    offers: allOffers,
    baseline,
    canonical,
    pricingSources,
    reverseMapping: reverseMappingForCanon,
    modelMapping: config.modelMapping,
  });

  for (const drop of plan.drops) {
    consola.info(
      `[pricing] drop ${drop.model} ${drop.channel} reason=${drop.reason}` +
        (drop.detail ? ` ${drop.detail}` : ""),
    );
  }

  const emitted = emitChannels({ plan, baseline });
  const mergedGroups = emitted.mergedGroups;
  const mergedModels = emitted.mergedModels;
  const channels = emitted.channels;

  // Collect pricing grid data from all providers' enabledModels
  const allPricingGrids: Record<string, Record<string, string | number>[]> = {};
  for (const provider of config.providers) {
    const grids = getPricingGridFromEnabledModels(provider.enabledModels);
    Object.assign(allPricingGrids, grids);
  }

  // Collect per-model metadata overrides from all providers' enabledModels.
  const allMetadata: Record<string, Record<string, unknown>> = {};
  for (const provider of config.providers) {
    const metadata = getMetadataFromEnabledModels(provider.enabledModels);
    Object.assign(allMetadata, metadata);
  }

  const optionMaps = buildOptionMaps(
    mergedGroups,
    mergedModels,
    config.modelMapping,
    allPricingGrids,
  );

  const reverseMapping = buildReverseMapping(config.modelMapping);

  const models = buildDesiredModels({
    channels,
    originalEndpointsByName,
    normalizedEndpointsByName,
    endpointPaths: aggregatedEndpointPaths,
    reverseMapping,
    basellmEntries,
    openRouterDescriptions,
    modelMapping: config.modelMapping,
    metadataByUpstream: allMetadata,
    pricingSources,
  });

  const responsesApiModels = collectResponsesApiModels(
    channels,
    normalizedEndpointsByName,
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
