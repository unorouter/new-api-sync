import type {
  ProviderConfig,
  RuntimeConfig,
  Sub2ApiProviderConfig,
} from "@/config";
import {
  ENDPOINT_DEFAULT_PATHS,
  inferVendorFromModelName,
  normalizeEndpointType,
} from "@/lib/constants";
import type {
  Channel,
  DesiredModelSpec,
  DesiredState,
  ProviderReport,
  SyncState,
} from "@/lib/types";
import { processNewApiProvider } from "@/providers/newapi/provider";
import { processSub2ApiProvider } from "@/providers/sub2api/provider";

export async function runProviderPipeline(
  config: RuntimeConfig,
): Promise<{ desired: DesiredState; providerReports: ProviderReport[] }> {
  const state: SyncState = {
    mergedGroups: [],
    mergedModels: new Map(),
    modelEndpoints: new Map(),
    modelOriginalEndpoints: new Map(),
    endpointPaths: new Map(),
    channelsToCreate: [],
  };

  // Process providers (newapi first, then sub2api)
  const sorted = [...config.providers].sort(
    (a, b) => (a.type === "newapi" ? -1 : 0) - (b.type === "newapi" ? -1 : 0),
  );
  const providerReports: ProviderReport[] = [];
  for (const [i, provider] of sorted.entries()) {
    if (i > 0) console.log();
    const report =
      provider.type === "newapi"
        ? await processNewApiProvider(provider as ProviderConfig, config, state)
        : await processSub2ApiProvider(
            provider as Sub2ApiProviderConfig,
            config,
            state,
          );
    providerReports.push(report);
  }

  // Dedupe channels by name (last write wins)
  const channelByName = new Map<string, Channel>();
  for (const ch of state.channelsToCreate) {
    channelByName.set(ch.name, ch);
  }
  const channels = [...channelByName.values()];

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
  for (const [name, ratios] of state.mergedModels) {
    const mappedName = config.modelMapping?.[name] ?? name;
    if (ratios.modelPrice !== undefined && ratios.modelPrice > 0) {
      modelPrice[mappedName] = Math.round(ratios.modelPrice * 10000) / 10000;
    } else {
      modelRatio[mappedName] = Math.round(ratios.ratio * 10000) / 10000;
      completionRatio[mappedName] =
        Math.round(ratios.completionRatio * 10000) / 10000;
    }
    if (ratios.imageRatio !== undefined && ratios.imageRatio > 0) {
      imageRatio[mappedName] = Math.round(ratios.imageRatio * 10000) / 10000;
    }
  }

  const models = new Map<string, DesiredModelSpec>();

  // Build reverse mapping (mapped name → original name) so we can look up
  // endpoint data that was stored under the original upstream name.
  const reverseMapping = new Map<string, string>();
  for (const [original, mapped] of Object.entries(config.modelMapping)) {
    reverseMapping.set(mapped, original);
  }

  for (const channel of channels) {
    const channelModels = channel.models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    for (const modelName of channelModels) {
      const vendor = inferVendorFromModelName(modelName);
      // Use original endpoint types for path lookup, normalized types for output keys
      const originalEps = state.modelOriginalEndpoints.get(modelName)
        ?? state.modelOriginalEndpoints.get(reverseMapping.get(modelName) ?? "");
      let endpoints: string | undefined;
      if (originalEps) {
        const epMap: Record<string, string> = {};
        for (const origEp of originalEps) {
          const normalized = normalizeEndpointType(origEp);
          const info = state.endpointPaths.get(origEp);
          const path = info?.path ?? ENDPOINT_DEFAULT_PATHS[normalized];
          if (path) epMap[normalized] = path;
        }
        if (Object.keys(epMap).length > 0) endpoints = JSON.stringify(epMap);
      }
      models.set(modelName, {
        model_name: modelName,
        vendor,
        endpoints,
      });
    }
  }

  return {
    providerReports,
    desired: {
      channels,
      models,
      options: {
        groupRatio,
        userUsableGroups,
        autoGroups,
        modelRatio,
        completionRatio,
        modelPrice,
        imageRatio,
        defaultUseAutoGroup: true,
      },
      managedProviders: new Set(
        config.providers.map((provider) => provider.name),
      ),
      mappingSources: new Set(Object.keys(config.modelMapping)),
    },
  };
}
