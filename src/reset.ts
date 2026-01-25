import { NekoClient } from "@/clients/neko-client";
import { NewApiClient } from "@/clients/newapi-client";
import { TargetClient } from "@/clients/target-client";
import { loadConfig } from "@/lib/config";
import { logError, logInfo } from "@/lib/utils";
import type { Config, NekoProviderConfig, ProviderConfig } from "@/types";
import { isNekoProvider } from "@/types";

async function reset(config: Config) {
  logInfo("Starting reset...\n");

  const providerNames = new Set(config.providers.map((p) => p.name));
  const target = new TargetClient(config.target);
  const channels = await target.listChannels();
  const channelsToDelete = channels.filter(
    (c) => c.tag && providerNames.has(c.tag),
  );

  let channelsDeleted = 0;
  for (const channel of channelsToDelete) {
    if (channel.id && (await target.deleteChannel(channel.id)))
      channelsDeleted++;
  }

  const models = await target.listModels();
  const modelsToDelete = models.filter((m) => m.sync_official === 1);

  let modelsDeleted = 0;
  for (const model of modelsToDelete) {
    if (model.id && (await target.deleteModel(model.id))) modelsDeleted++;
  }

  let totalTokensDeleted = 0;
  for (const providerConfig of config.providers) {
    if (isNekoProvider(providerConfig)) {
      const neko = new NekoClient(providerConfig as NekoProviderConfig);
      const tokens = await neko.listTokens();
      const tokensToDelete = tokens.filter((t) =>
        t.name.endsWith(`-${providerConfig.name}`),
      );

      for (const token of tokensToDelete) {
        if (await neko.deleteToken(token.id)) {
          totalTokensDeleted++;
          logInfo(`[${providerConfig.name}] Deleted token: ${token.name}`);
        } else {
          logError(`Failed to delete token: ${token.name}`);
        }
      }
    } else {
      const upstream = new NewApiClient(providerConfig as ProviderConfig);
      const tokens = await upstream.listTokens();
      const tokensToDelete = tokens.filter((t) =>
        t.name.endsWith(`-${providerConfig.name}`),
      );

      for (const token of tokensToDelete) {
        if (await upstream.deleteToken(token.id)) totalTokensDeleted++;
        else logError(`Failed to delete token: ${token.name}`);
      }
    }
  }

  logInfo(
    `Done | Channels: -${channelsDeleted} | Models: -${modelsDeleted} | Tokens: -${totalTokensDeleted}`,
  );
}

const config = await loadConfig(process.argv[2] ?? "./config.json");
await reset(config);
