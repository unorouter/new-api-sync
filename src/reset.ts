/**
 * Reset script - deletes all channels on target and all tokens on providers
 */

import type { Config } from "@/types";
import { loadConfig } from "@/lib/config";
import { UpstreamClient } from "@/clients/upstream-client";
import { TargetClient } from "@/clients/target-client";
import { logInfo, logError } from "@/lib/utils";

async function reset(config: Config) {
  logInfo("=".repeat(60));
  logInfo("Starting reset...");
  logInfo("=".repeat(60));

  // Delete all channels on target
  logInfo("\n[Deleting target channels]");
  const target = new TargetClient(config.target);
  const channels = await target.listChannels();

  let channelsDeleted = 0;
  for (const channel of channels) {
    if (channel.id) {
      const success = await target.deleteChannel(channel.id);
      if (success) channelsDeleted++;
    }
  }
  logInfo(`Deleted ${channelsDeleted}/${channels.length} channels`);

  // Delete all tokens on each provider
  for (const providerConfig of config.providers) {
    logInfo(`\n[Deleting tokens on ${providerConfig.name}]`);
    const upstream = new UpstreamClient(providerConfig);

    const tokens = await upstream.listTokens();
    let tokensDeleted = 0;

    for (const token of tokens) {
      const success = await upstream.deleteToken(token.id);
      if (success) {
        tokensDeleted++;
        logInfo(`Deleted token: ${token.name}`);
      } else {
        logError(`Failed to delete token: ${token.name}`);
      }
    }
    logInfo(`Deleted ${tokensDeleted}/${tokens.length} tokens on ${providerConfig.name}`);
  }

  logInfo("\n" + "=".repeat(60));
  logInfo("Reset complete!");
  logInfo("=".repeat(60));
}

const config = await loadConfig(process.argv[2] ?? "./config.json");
await reset(config);
