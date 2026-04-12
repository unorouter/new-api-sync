import {
  getPricingGridFromEnabledModels,
  type DirectProviderConfig,
  type NvidiaProviderConfig,
  type ProviderConfig,
  type RuntimeConfig,
  type Sub2ApiProviderConfig,
} from "@core/config";
import {
  buildReverseMapping,
  ENDPOINT_DEFAULT_PATHS,
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
import type {
  Channel,
  DesiredModelSpec,
  DesiredState,
  ManagedOptionMaps,
  ProviderReport,
  SyncState,
  TargetSnapshot,
} from "@core/types";
import { NewApiClient } from "@core/providers/newapi/client";
import { processDirectProvider } from "@core/providers/direct/provider";
import { processNewApiProvider } from "@core/providers/newapi/provider";
import { processNvidiaProvider } from "@core/providers/nvidia/provider";
import { processSub2ApiProvider } from "@core/providers/sub2api/provider";
import { consola } from "consola";

/**
 * Backfill model ratios from pre-fetched basellm entries for models
 * present in channels but missing from state.mergedModels.
 */
function backfillModelRatios(
  state: SyncState,
  channels: Channel[],
  modelMapping: Record<string, string>,
  basellmEntries: BasellmEntry[],
): void {
  // Collect all model names used in channels
  const channelModels = new Set<string>();
  for (const ch of channels) {
    for (const m of parseModelList(ch.models)) channelModels.add(m);
  }

  // Find models missing ratio data
  const missing = [...channelModels].filter((m) => !state.mergedModels.has(m));
  if (missing.length === 0) return;

  if (basellmEntries.length === 0) {
    consola.warn("No basellm entries available for ratio backfill");
    return;
  }

  // Build a map of model_name → cheapest ratios (lowest ratio_model wins)
  const upstreamRatios = new Map<
    string,
    { ratio: number; completionRatio: number }
  >();
  for (const entry of basellmEntries) {
    if (!entry.model_name || entry.ratio_model == null) continue;
    const existing = upstreamRatios.get(entry.model_name);
    if (!existing || entry.ratio_model < existing.ratio) {
      upstreamRatios.set(entry.model_name, {
        ratio: entry.ratio_model,
        completionRatio: entry.ratio_completion ?? 1,
      });
    }
  }

  const reverseMapping = buildReverseMapping(modelMapping);

  let filled = 0;
  for (const model of missing) {
    // Try mapped name first, then original
    const lookupName = reverseMapping.get(model) ?? model;
    const upstream =
      upstreamRatios.get(lookupName) ?? upstreamRatios.get(model);
    if (upstream) {
      state.mergedModels.set(model, {
        ratio: upstream.ratio,
        completionRatio: upstream.completionRatio,
      });
      filled++;
    }
  }

  if (filled > 0) {
    consola.info(
      `Backfilled ${filled}/${missing.length} model ratios from upstream library`,
    );
  }
  if (filled < missing.length) {
    const unfilled = missing.filter((m) => !state.mergedModels.has(m));
    // Show which channels reference each unfilled model
    const details = unfilled.map((m) => {
      const refs = channels
        .filter((ch) => parseModelList(ch.models).includes(m))
        .map((ch) => ch.tag ?? ch.name);
      return refs.length > 0 ? `${m} (${refs.join(", ")})` : m;
    });
    consola.warn(`No upstream ratios for: ${details.join(", ")}`);
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

  // Add model type tag and deduplicate
  for (const [modelName, spec] of models) {
    const originalName = opts.reverseMapping.get(modelName) ?? modelName;
    const eps =
      opts.state.modelEndpoints.get(modelName) ??
      opts.state.modelEndpoints.get(originalName);
    const modelType = inferModelType(modelName, eps);
    const typeTag = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const rawTags = spec.tags ? `${typeTag},${spec.tags}` : typeTag;
    const seen = new Set<string>();
    const deduped = rawTags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => {
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
      `[baseline] Seeded ${state.channelsToCreate.length} channels, ${state.mergedGroups.length} groups from target`,
    );
    for (const g of state.mergedGroups) {
      consola.debug(
        `[baseline]   "${g.name}" ratio=${g.ratio.toFixed(4)} provider=${g.provider}`,
      );
    }
  }
  const baselineChannelCount = state.channelsToCreate.length;
  const baselineGroupCount = state.mergedGroups.length;

  // Start metadata fetches in parallel (run while providers process)
  const metadataPromise = Promise.all([
    fetchBasellmEntries(),
    fetchOpenRouterDescriptions(),
  ]);

  // Process providers (newapi first, then direct, then sub2api last)
  const typeOrder: Record<string, number> = {
    newapi: 0,
    nvidia: 1,
    direct: 2,
    sub2api: 3,
  };
  const sorted = [...config.providers].sort(
    (a, b) => (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2),
  );
  const providerReports: ProviderReport[] = [];
  for (const [i, provider] of sorted.entries()) {
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

  // Dedupe channels by name (last write wins)
  const channelByName = new Map<string, Channel>();
  for (const ch of state.channelsToCreate) {
    channelByName.set(ch.name, ch);
  }
  const channels = [...channelByName.values()];

  // Resolve metadata fetches (started in parallel with provider processing)
  const [basellmEntries, openRouterDescriptions] = await metadataPromise;

  // Backfill model ratios from basellm for models without ratio data
  // (e.g. sub2api-only models where no newapi provider supplied pricing)
  backfillModelRatios(state, channels, config.modelMapping, basellmEntries);

  // Collect pricing grid data from all providers' enabledModels
  const allPricingGrids: Record<string, Record<string, string | number>[]> = {};
  for (const provider of config.providers) {
    const grids = getPricingGridFromEnabledModels(provider.enabledModels);
    Object.assign(allPricingGrids, grids);
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
