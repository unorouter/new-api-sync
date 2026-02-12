import { NewApiClient } from "@/clients/newapi-client";
import type { Config, ResetReport } from "@/lib/types";
import { consola } from "consola";

export class ResetService {
  constructor(private config: Config) {}

  async reset(): Promise<ResetReport> {
    consola.info("Starting reset...\n");

    const report: ResetReport = {
      channels: 0,
      models: 0,
      orphans: 0,
      tokens: 0,
      options: 0,
    };

    const providerNames = new Set(this.config.providers.map((p) => p.name));
    const target = new NewApiClient(this.config.target);

    // Delete channels tagged with provider names
    const channels = await target.listChannels();
    for (const channel of channels) {
      if (channel.id && channel.tag && providerNames.has(channel.tag)) {
        if (await target.deleteChannel(channel.id)) report.channels++;
      }
    }

    // Delete sync_official models
    const models = await target.listModels();
    for (const model of models) {
      if (model.id && model.sync_official === 1) {
        if (await target.deleteModel(model.id)) report.models++;
      }
    }

    // Cleanup orphaned models
    report.orphans = await target.cleanupOrphanedModels();

    // Delete provider tokens (only for newapi providers, sub2api has no token management)
    for (const providerConfig of this.config.providers) {
      if (providerConfig.type === "sub2api") continue;
      const suffix = `-${providerConfig.name}`;
      const client = new NewApiClient(providerConfig);
      const tokens = await client.listTokens();
      for (const token of tokens) {
        if (token.name.endsWith(suffix)) {
          if (await client.deleteToken(token.id)) report.tokens++;
        }
      }
    }

    // Clear sync-related options
    const optionsResult = await target.updateOptions({
      GroupRatio: "{}",
      UserUsableGroups: JSON.stringify({ auto: "Auto (Smart Routing with Failover)" }),
      AutoGroups: "[]",
      ModelRatio: "{}",
      CompletionRatio: "{}",
    });
    report.options = optionsResult.updated.length;

    const orphanStr = report.orphans > 0 ? ` | Orphans: -${report.orphans}` : "";
    consola.info(
      `Done | Channels: -${report.channels} | Models: -${report.models}${orphanStr} | Tokens: -${report.tokens} | Options cleared: ${report.options}`,
    );

    return report;
  }
}
