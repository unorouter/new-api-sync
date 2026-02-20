import type { RuntimeConfig } from "@/config";
import {
  applyModelMapping,
  ENDPOINT_DEFAULT_PATHS,
  inferVendorFromModelName
} from "@/lib/constants";
import type {
  Channel,
  DesiredModelSpec,
  DesiredState,
  PolicyState,
  ProviderReport,
  SyncState
} from "@/lib/types";
import { buildAdapters } from "@/providers/factory";
import type { NewApiClient } from "@/providers/newapi/client";

// ============ Responses Policy ============

const RESPONSES_COMPATIBLE_CHANNEL_TYPES = new Set([1, 17, 39, 27, 45, 57, 48]);
const RESPONSES_ENDPOINTS = new Set([
  "openai-response",
  "openai-response-compact"
]);

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildResponsesPolicy(
  channels: Channel[],
  modelEndpoints: Map<string, string[]>
): PolicyState {
  const channelTypes = [
    ...new Set(
      channels
        .map((channel) => channel.type)
        .filter((type) => RESPONSES_COMPATIBLE_CHANNEL_TYPES.has(type))
    )
  ].sort((a, b) => a - b);

  const models = new Set<string>();
  for (const channel of channels) {
    if (!RESPONSES_COMPATIBLE_CHANNEL_TYPES.has(channel.type)) continue;
    const channelModels = channel.models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    for (const model of channelModels) {
      const endpoints = modelEndpoints.get(model);
      if (!endpoints || endpoints.length === 0) {
        models.add(model);
        continue;
      }
      if (endpoints.some((endpoint) => RESPONSES_ENDPOINTS.has(endpoint))) {
        models.add(model);
      }
    }
  }

  const modelPatterns = [...models]
    .sort((a, b) => a.localeCompare(b))
    .map((model) => `^${escapeRegExp(model)}$`);

  const enabled = channelTypes.length > 0 && modelPatterns.length > 0;

  return {
    enabled,
    all_channels: false,
    channel_types: channelTypes,
    model_patterns: modelPatterns
  };
}

// ============ Pipeline Helpers ============

function buildModelEndpoints(endpointTypes: string[]): string | undefined {
  const endpoints: Record<string, string> = {};
  for (const endpointType of endpointTypes) {
    const path = ENDPOINT_DEFAULT_PATHS[endpointType];
    if (path) endpoints[endpointType] = path;
  }
  if (Object.keys(endpoints).length === 0) return undefined;
  return JSON.stringify(endpoints);
}

function createChannelSpec(
  channel: SyncState["channelsToCreate"][number]
): Channel {
  return {
    name: channel.name,
    type: channel.type,
    key: channel.key,
    base_url: channel.baseUrl.replace(/\/$/, ""),
    models: channel.models.join(","),
    group: channel.group,
    priority: channel.priority,
    weight: channel.weight,
    status: 1,
    tag: channel.provider,
    remark: channel.remark,
    model_mapping: channel.modelMapping
      ? JSON.stringify(channel.modelMapping)
      : undefined
  };
}

function dedupeChannels(channels: Channel[]): Channel[] {
  const byName = new Map<string, Channel>();
  for (const channel of channels) {
    byName.set(channel.name, channel);
  }
  return [...byName.values()];
}

// ============ Pipeline ============

export async function seedPricingContext(
  config: RuntimeConfig,
  target: NewApiClient,
  state: SyncState
): Promise<void> {
  const existingChannels = await target.listChannels();
  const groupRatioJson = (await target.getOptions(["GroupRatio"]))[
    "GroupRatio"
  ];
  let groupRatios: Record<string, number> = {};
  try {
    groupRatios = groupRatioJson ? JSON.parse(groupRatioJson) : {};
  } catch {
    groupRatios = {};
  }
  const activeProviders = new Set(
    config.providers.map((provider) => provider.name)
  );

  for (const channel of existingChannels) {
    if (!channel.tag || activeProviders.has(channel.tag)) continue;

    state.mergedGroups.push({
      name: channel.group,
      ratio: groupRatios[channel.group] ?? 1,
      description: channel.remark ?? channel.name,
      provider: channel.tag
    });

    state.pricingContext.push({
      models: channel.models
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
      group: channel.group,
      provider: channel.tag
    });
  }
}

export async function runProviderPipeline(
  config: RuntimeConfig,
  target: NewApiClient
): Promise<{ desired: DesiredState; providerReports: ProviderReport[] }> {
  const state: SyncState = {
    mergedGroups: [],
    mergedModels: new Map(),
    modelEndpoints: new Map(),
    channelsToCreate: [],
    pricingContext: []
  };
  await seedPricingContext(config, target, state);

  const adapters = buildAdapters(config, state);
  const providerReports: ProviderReport[] = [];

  for (const adapter of adapters) {
    const report = await adapter.materialize();
    providerReports.push(report);
  }

  const channels = dedupeChannels(
    state.channelsToCreate.map(createChannelSpec)
  );

  const groupRatio: Record<string, number> = {};
  const userUsableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)"
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
    // Apply model mapping so pricing keys match the mapped model names on the target
    const mappedName = applyModelMapping(name, config.modelMapping);
    if (ratios.modelPrice !== undefined && ratios.modelPrice > 0) {
      // Fixed-price model (quota_type 1)
      modelPrice[mappedName] = Math.round(ratios.modelPrice * 10000) / 10000;
    } else {
      // Ratio-based model (quota_type 0)
      modelRatio[mappedName] = Math.round(ratios.ratio * 10000) / 10000;
      completionRatio[mappedName] =
        Math.round(ratios.completionRatio * 10000) / 10000;
    }
    if (ratios.imageRatio !== undefined && ratios.imageRatio > 0) {
      imageRatio[mappedName] = Math.round(ratios.imageRatio * 10000) / 10000;
    }
  }

  const models = new Map<string, DesiredModelSpec>();

  for (const channel of channels) {
    const channelModels = channel.models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    for (const modelName of channelModels) {
      const vendor = inferVendorFromModelName(modelName);
      const endpointTypes = state.modelEndpoints.get(modelName);
      models.set(modelName, {
        model_name: modelName,
        vendor,
        endpoints: endpointTypes
          ? buildModelEndpoints(endpointTypes)
          : undefined
      });
    }
  }

  const policy = buildResponsesPolicy(channels, state.modelEndpoints);

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
        defaultUseAutoGroup: true
      },
      policy,
      managedProviders: new Set(
        config.providers.map((provider) => provider.name)
      ),
      mappingSources: new Set(Object.keys(config.modelMapping))
    }
  };
}
