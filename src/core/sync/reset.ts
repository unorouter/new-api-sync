import {
  matchesAnyPattern,
  parseModelList,
} from "@core/catalog/constants/patterns";
import type { RuntimeConfig } from "@core/config";
import { throwIfRunAborted } from "@core/infra/abort";
import { MANAGED_OPTION_KEYS } from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";

function buildOptionResetValues(): Record<string, string> {
  return {
    UserUsableGroups: JSON.stringify({ auto: t("CORE.GROUPS.AUTO_LABEL") }),
    AutoGroups: "[]",
    DefaultUseAutoGroup: "true",
    "global.chat_completions_to_responses_policy": JSON.stringify({
      enabled: false,
      all_channels: false,
      channel_types: [1],
      model_patterns: [],
    }),
  };
}

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
  const providerNames = new Set(config.providers.map((p) => p.name));

  const hasOnly = !!opts?.onlyProviders;
  const modelGlobs = config.modelFilter ?? [];
  const hasModels = modelGlobs.length > 0;
  const hasAnyFilter = hasOnly || hasModels;

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
      const removed = models.filter((n) => matchesAnyPattern(n, modelGlobs));
      if (removed.length === 0) continue;
      const kept = models.filter((n) => !matchesAnyPattern(n, modelGlobs));
      if (kept.length === 0) {
        if (await target.deleteChannel(channel.id)) {
          channelsDeleted++;
          for (const name of removed) impactedModelNames.add(name);
        }
      } else if (
        await target.updateChannel({ ...channel, models: kept.join(",") })
      ) {
        channelsUpdated++;
      }
    } else if (await target.deleteChannel(channel.id)) {
      channelsDeleted++;
      if (hasOnly) {
        for (const name of parseModelList(channel.models ?? ""))
          impactedModelNames.add(name);
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
    const resetValues = buildOptionResetValues();
    for (const key of MANAGED_OPTION_KEYS) {
      if (await target.updateOption(key, resetValues[key] ?? "{}"))
        optionsUpdated.push(key);
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
