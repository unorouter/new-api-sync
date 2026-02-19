import type { RuntimeConfig } from "@/config/schema";
import type { DesiredModelSpec, DesiredState } from "@/core/types";
import { ENDPOINT_DEFAULT_PATHS, inferVendorFromModelName } from "@/lib/constants";
import type { Channel, ProviderReport, SyncState } from "@/lib/types";
import type { AdapterContext } from "@/providers/adapter";
import { buildAdapters } from "@/providers/factory";
import { buildResponsesPolicy } from "@/target/policy";
import { TargetClient } from "@/target/client";

function buildModelEndpoints(endpointTypes: string[]): string | undefined {
  const endpoints: Record<string, string> = {};
  for (const endpointType of endpointTypes) {
    const path = ENDPOINT_DEFAULT_PATHS[endpointType];
    if (path) endpoints[endpointType] = path;
  }
  if (Object.keys(endpoints).length === 0) return undefined;
  return JSON.stringify(endpoints);
}

function createChannelSpec(channel: SyncState["channelsToCreate"][number]): Channel {
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
  };
}

function dedupeChannels(channels: Channel[]): Channel[] {
  const byName = new Map<string, Channel>();
  for (const channel of channels) {
    byName.set(channel.name, channel);
  }
  return [...byName.values()];
}

export async function seedPricingContext(
  config: RuntimeConfig,
  target: TargetClient,
  state: SyncState,
): Promise<void> {
  const existingChannels = await target.listChannels();
  const groupRatioJson = (await target.getOptions(["GroupRatio"]))["GroupRatio"];
  let groupRatios: Record<string, number> = {};
  try {
    groupRatios = groupRatioJson ? JSON.parse(groupRatioJson) : {};
  } catch {
    groupRatios = {};
  }
  const activeProviders = new Set(config.providers.map((provider) => provider.name));

  for (const channel of existingChannels) {
    if (!channel.tag || activeProviders.has(channel.tag)) continue;

    state.mergedGroups.push({
      name: channel.group,
      ratio: groupRatios[channel.group] ?? 1,
      description: channel.remark ?? channel.name,
      provider: channel.tag,
    });

    state.pricingContext.push({
      models: channel.models.split(",").map((model) => model.trim()).filter(Boolean),
      group: channel.group,
      provider: channel.tag,
    });
  }
}

export async function runProviderPipeline(
  config: RuntimeConfig,
  target: TargetClient,
): Promise<{ desired: DesiredState; providerReports: ProviderReport[] }> {
  const state: SyncState = {
    mergedGroups: [],
    mergedModels: new Map(),
    modelEndpoints: new Map(),
    channelsToCreate: [],
    pricingContext: [],
  };
  await seedPricingContext(config, target, state);

  const context: AdapterContext = {
    config,
    state,
  };

  const adapters = buildAdapters(config, context);
  const providerReports: ProviderReport[] = [];

  for (const adapter of adapters) {
    await adapter.discover();
    await adapter.test();
    const report = await adapter.materialize();
    providerReports.push(report);
  }

  const channels = dedupeChannels(state.channelsToCreate.map(createChannelSpec));

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
  for (const [name, ratios] of state.mergedModels) {
    modelRatio[name] = Math.round(ratios.ratio * 10000) / 10000;
    completionRatio[name] = Math.round(ratios.completionRatio * 10000) / 10000;
  }

  const models = new Map<string, DesiredModelSpec>();

  for (const channel of channels) {
    const channelModels = channel.models.split(",").map((model) => model.trim()).filter(Boolean);
    for (const modelName of channelModels) {
      const vendor = inferVendorFromModelName(modelName);
      const endpointTypes = state.modelEndpoints.get(modelName);
      models.set(modelName, {
        model_name: modelName,
        vendor,
        endpoints: endpointTypes ? buildModelEndpoints(endpointTypes) : undefined,
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
        defaultUseAutoGroup: true,
      },
      policy,
      managedProviders: new Set(config.providers.map((provider) => provider.name)),
      mappingSources: new Set(Object.keys(config.modelMapping)),
    },
  };
}
