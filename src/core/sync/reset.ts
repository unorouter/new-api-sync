import { throwIfRunAborted } from "@core/runtime/abort";
import type { RuntimeConfig } from "@core/config";
import {
  matchesAnyPattern,
  parseModelList,
} from "@core/catalog/constants/patterns";
import { NewApiClient } from "@core/vendors/newapi/client";

export interface ResetResult {
  channelsDeleted: number;
  channelsUpdated: number;
  modelsDeleted: number;
  orphanModelsDeleted: number;
  tokensDeleted: number;
  optionsUpdated: string[];
}

export interface RunResetOptions {
  onlyProviders?: boolean;
}

export async function runReset(
  config: RuntimeConfig,
  opts?: RunResetOptions,
): Promise<ResetResult> {
  const target = new NewApiClient(config.target, "target");
  const providerNames = new Set(
    config.providers.map((provider) => provider.name),
  );

  const hasOnly = !!opts?.onlyProviders;
  const hasModels = (config.modelFilter?.length ?? 0) > 0;
  const hasAnyFilter = hasOnly || hasModels;
  const modelGlobs = config.modelFilter ?? [];

  let channelsDeleted = 0;
  let channelsUpdated = 0;
  const impactedModelNames = new Set<string>();

  const channels = await target.listChannels();
  for (const channel of channels) {
    throwIfRunAborted();
    if (!channel.id || !channel.tag) continue;
    if (hasOnly && !providerNames.has(channel.tag)) continue;

    if (hasModels) {
      const models = parseModelList(channel.models ?? "");
      const removed = models.filter((name) =>
        matchesAnyPattern(name, modelGlobs),
      );
      if (removed.length === 0) continue;
      const kept = models.filter(
        (name) => !matchesAnyPattern(name, modelGlobs),
      );
      if (kept.length === 0) {
        if (await target.deleteChannel(channel.id)) {
          channelsDeleted++;
          for (const name of removed) impactedModelNames.add(name);
        }
      } else {
        const updated = { ...channel, models: kept.join(",") };
        if (await target.updateChannel(updated)) channelsUpdated++;
      }
    } else {
      if (await target.deleteChannel(channel.id)) {
        channelsDeleted++;
        if (hasOnly) {
          for (const name of parseModelList(channel.models ?? "")) {
            impactedModelNames.add(name);
          }
        }
      }
    }
  }

  let modelsDeleted = 0;
  const models = await target.listModels();
  for (const model of models) {
    throwIfRunAborted();
    if (!model.id || model.sync_official !== 1) continue;
    if (hasModels) {
      if (!matchesAnyPattern(model.model_name, modelGlobs)) continue;
    } else if (hasOnly) {
      if (!impactedModelNames.has(model.model_name)) continue;
    }
    if (await target.deleteModel(model.id)) modelsDeleted++;
  }

  throwIfRunAborted();
  const orphanModelsDeleted = hasAnyFilter
    ? 0
    : await target.cleanupOrphanedModels();

  let tokensDeleted = 0;
  let liveChannelKeys: Set<string> | null = null;
  if (hasModels && !hasOnly) {
    const liveChannels = await target.listChannels();
    liveChannelKeys = new Set(liveChannels.map((c) => c.key).filter(Boolean));
  }

  for (const provider of config.providers) {
    throwIfRunAborted();
    if (provider.type !== "newapi") continue;
    const client = new NewApiClient(provider, provider.name);
    const tokens = await client.listTokens();
    const suffix = config.target.targetPrefix
      ? `-${provider.name}-${config.target.targetPrefix}`
      : `-${provider.name}`;
    for (const token of tokens) {
      throwIfRunAborted();
      if (!token.name.endsWith(suffix)) continue;
      if (liveChannelKeys && liveChannelKeys.has(token.key)) continue;
      if (await client.deleteToken(token.id)) tokensDeleted++;
    }
  }

  const optionsUpdated: string[] = [];
  if (!hasAnyFilter) {
    const options: Record<string, string> = {
      GroupRatio: "{}",
      UserUsableGroups: JSON.stringify({
        auto: "Auto (Smart Routing with Failover)",
      }),
      AutoGroups: "[]",
      DefaultUseAutoGroup: "true",
      ModelRatio: "{}",
      CompletionRatio: "{}",
      ModelPrice: "{}",
      ImageRatio: "{}",
      CacheRatio: "{}",
      CreateCacheRatio: "{}",
      ModelQuotaType: "{}",
      ModelGridPricing: "{}",
    };
    for (const [key, value] of Object.entries(options)) {
      if (await target.updateOption(key, value)) optionsUpdated.push(key);
    }
  }

  return {
    channelsDeleted,
    channelsUpdated,
    modelsDeleted,
    orphanModelsDeleted,
    tokensDeleted,
    optionsUpdated,
  };
}
