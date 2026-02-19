import type { RuntimeConfig } from "@/config";
import { NewApiClient } from "@/providers/newapi/client";

export interface ResetResult {
  channelsDeleted: number;
  modelsDeleted: number;
  orphanModelsDeleted: number;
  tokensDeleted: number;
  optionsUpdated: string[];
}

export async function runReset(config: RuntimeConfig): Promise<ResetResult> {
  const target = new NewApiClient(config.target, "target");
  const providerNames = new Set(config.providers.map((provider) => provider.name));

  let channelsDeleted = 0;
  const channels = await target.listChannels();
  for (const channel of channels) {
    if (!channel.id || !channel.tag) continue;
    if (providerNames.size > 0 && !providerNames.has(channel.tag)) continue;
    if (await target.deleteChannel(channel.id)) channelsDeleted++;
  }

  let modelsDeleted = 0;
  const models = await target.listModels();
  for (const model of models) {
    if (!model.id || model.sync_official !== 1) continue;
    if (await target.deleteModel(model.id)) modelsDeleted++;
  }

  const orphanModelsDeleted = await target.cleanupOrphanedModels();

  let tokensDeleted = 0;
  for (const provider of config.providers) {
    if (provider.type !== "newapi") continue;
    const client = new NewApiClient(provider, provider.name);
    const tokens = await client.listTokens();
    const suffix = `-${provider.name}`;
    for (const token of tokens) {
      if (!token.name.endsWith(suffix)) continue;
      if (await client.deleteToken(token.id)) tokensDeleted++;
    }
  }

  const options = {
    GroupRatio: "{}",
    UserUsableGroups: JSON.stringify({ auto: "Auto (Smart Routing with Failover)" }),
    AutoGroups: "[]",
    DefaultUseAutoGroup: "true",
    ModelRatio: "{}",
    CompletionRatio: "{}",
    "global.chat_completions_to_responses_policy": JSON.stringify({
      enabled: false,
      all_channels: false,
      channel_types: [],
      model_patterns: [],
    }),
  };

  const optionsResult = await target.updateOptions(options);

  return {
    channelsDeleted,
    modelsDeleted,
    orphanModelsDeleted,
    tokensDeleted,
    optionsUpdated: optionsResult.updated,
  };
}
