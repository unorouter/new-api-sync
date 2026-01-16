import type { Config } from "@/types";
import { loadConfig } from "@/lib/config";
import { UpstreamClient } from "@/clients/upstream-client";
import { TargetClient } from "@/clients/target-client";
import { logInfo, logError } from "@/lib/utils";

async function reset(config: Config) {
  logInfo("Starting reset...\n");

  const providerNames = new Set(config.providers.map((p) => p.name));
  const target = new TargetClient(config.target);
  const channels = await target.listChannels();
  const channelsToDelete = channels.filter((c) => c.tag && providerNames.has(c.tag));

  let channelsDeleted = 0;
  for (const channel of channelsToDelete) {
    if (channel.id && await target.deleteChannel(channel.id)) channelsDeleted++;
  }

  let totalTokensDeleted = 0;
  for (const providerConfig of config.providers) {
    const upstream = new UpstreamClient(providerConfig);
    const tokens = await upstream.listTokens();
    const tokensToDelete = tokens.filter((t) => t.name.endsWith(`-${providerConfig.name}`));

    for (const token of tokensToDelete) {
      if (await upstream.deleteToken(token.id)) totalTokensDeleted++;
      else logError(`Failed to delete token: ${token.name}`);
    }
  }

  logInfo(`Done | Channels: -${channelsDeleted} | Tokens: -${totalTokensDeleted}`);
}

const config = await loadConfig(process.argv[2] ?? "./config.json");
await reset(config);
