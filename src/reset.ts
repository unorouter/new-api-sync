import { NekoClient } from "@/clients/neko-client";
import { NewApiClient } from "@/clients/newapi-client";
import { loadConfig } from "@/lib/config";
import type { Config, NekoProviderConfig, ProviderConfig } from "@/lib/types";
import { consola } from "consola";

async function reset(config: Config) {
  consola.info("Starting reset...\n");

  const providerNames = new Set(config.providers.map((p) => p.name));
  const target = new NewApiClient(config.target);
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

  // Cleanup orphaned models directly from database
  const orphansDeleted = await target.cleanupOrphanedModels();

  let totalTokensDeleted = 0;
  for (const providerConfig of config.providers) {
    if (providerConfig.type === "neko") {
      const neko = new NekoClient(providerConfig as NekoProviderConfig);
      const tokens = await neko.listTokens();
      const tokensToDelete = tokens.filter((t) =>
        t.name.endsWith(`-${providerConfig.name}`),
      );

      for (const token of tokensToDelete) {
        if (await neko.deleteToken(token.id)) {
          totalTokensDeleted++;
          consola.info(`[${providerConfig.name}] Deleted token: ${token.name}`);
        } else {
          consola.error(`Failed to delete token: ${token.name}`);
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
        else consola.error(`Failed to delete token: ${token.name}`);
      }
    }
  }

  // Clear sync-related options (GroupRatio, UserUsableGroups, AutoGroups, ModelRatio, CompletionRatio)
  const optionsResult = await target.updateOptions({
    GroupRatio: "{}",
    UserUsableGroups: JSON.stringify({ auto: "Auto (Smart Routing with Failover)" }),
    AutoGroups: "[]",
    ModelRatio: "{}",
    CompletionRatio: "{}",
  });

  const orphanStr = orphansDeleted > 0 ? ` | Orphans: -${orphansDeleted}` : "";
  consola.info(
    `Done | Channels: -${channelsDeleted} | Models: -${modelsDeleted}${orphanStr} | Tokens: -${totalTokensDeleted} | Options cleared: ${optionsResult.updated.length}`,
  );
}

const config = await loadConfig(process.argv[2] ?? "./config.json");
await reset(config);
