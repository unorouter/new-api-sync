/**
 * Main sync orchestration
 * Idempotent sync from multiple upstream providers to target instance
 */

import type {
  Config,
  SyncReport,
  ProviderReport,
  MergedGroup,
  MergedModel,
  Channel,
  GroupInfo,
  ModelInfo,
} from "@/types";
import { validateConfig } from "@/lib/config";
import { UpstreamClient } from "@/clients/upstream-client";
import { TargetClient } from "@/clients/target-client";
import { logInfo, logError } from "@/lib/utils";

/**
 * Sync all providers to target instance
 * Idempotent: can be run multiple times safely
 */
export async function sync(config: Config): Promise<SyncReport> {
  const startTime = Date.now();

  // Validate config
  validateConfig(config);

  const report: SyncReport = {
    success: true,
    providers: [],
    channels: { created: 0, updated: 0, deleted: 0 },
    options: { updated: [] },
    errors: [],
    timestamp: new Date(),
  };

  // Merged data from all providers
  const mergedGroups: MergedGroup[] = [];
  const mergedModels = new Map<string, MergedModel>();
  const upstreamModels: ModelInfo[] = [];
  const channelsToCreate: Array<{
    name: string;
    type: number;
    key: string;
    baseUrl: string;
    models: string[];
    group: string;
    priority: number;
    provider: string;
  }> = [];

  logInfo("=".repeat(60));
  logInfo("Starting sync...");
  logInfo("=".repeat(60));

  // ==========================================================================
  // Phase 1: Collect data from all providers
  // ==========================================================================

  for (const providerConfig of config.providers) {
    const providerReport: ProviderReport = {
      name: providerConfig.name,
      success: false,
      groups: 0,
      models: 0,
      tokens: { created: 0, existing: 0 },
    };

    try {
      logInfo(`\n[Provider: ${providerConfig.name}]`);
      const upstream = new UpstreamClient(providerConfig);

      // Fetch pricing
      const pricing = await upstream.fetchPricing();

      // Filter groups if enabledGroups specified
      let groups: GroupInfo[];
      if (
        providerConfig.enabledGroups &&
        providerConfig.enabledGroups.length > 0
      ) {
        groups = pricing.groups.filter((g) =>
          providerConfig.enabledGroups!.includes(g.name)
        );
        logInfo(
          `Filtered to ${groups.length} groups: ${groups.map((g) => g.name).join(", ")}`
        );
      } else {
        groups = pricing.groups;
      }

      // Log models per group
      for (const group of groups) {
        logInfo(`  Group "${group.name}" has ${group.models.length} models: ${group.models.slice(0, 5).join(", ")}${group.models.length > 5 ? ` ... and ${group.models.length - 5} more` : ""}`);
      }

      // Ensure tokens exist on upstream (use provider name as prefix for consistency with channel names)
      const tokenResult = await upstream.ensureTokens(groups, providerConfig.name);
      providerReport.tokens = {
        created: tokenResult.created,
        existing: tokenResult.existing,
      };

      // Collect prefixed groups and channel specs
      for (const group of groups) {
        const prefixedName = `${group.name}-${providerConfig.name}`;

        mergedGroups.push({
          name: prefixedName,
          ratio: group.ratio,
          description: `${group.description} [${providerConfig.name}]`,
          provider: providerConfig.name,
        });

        channelsToCreate.push({
          name: prefixedName,
          type: group.channelType,
          key: tokenResult.tokens[group.name] ?? "",
          baseUrl: providerConfig.baseUrl,
          models: group.models,
          group: prefixedName,
          priority: providerConfig.priority ?? 0,
          provider: providerConfig.name,
        });
      }

      // Merge model ratios (lowest wins for duplicates)
      for (const model of pricing.models) {
        const existing = mergedModels.get(model.name);
        if (!existing || model.ratio < existing.ratio) {
          mergedModels.set(model.name, {
            ratio: model.ratio,
            completionRatio: model.completionRatio,
          });
        }
        // Collect all upstream models for model sync
        if (!upstreamModels.find((m) => m.name === model.name)) {
          upstreamModels.push(model);
        }
      }

      providerReport.groups = groups.length;
      providerReport.models = pricing.models.length;
      providerReport.success = true;

      logInfo(
        `Provider ${providerConfig.name}: ${groups.length} groups, ${pricing.models.length} models`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerReport.error = message;
      report.errors.push({
        provider: providerConfig.name,
        phase: "fetch",
        message,
      });
      logError(`Provider ${providerConfig.name} failed: ${message}`);
      // Continue with other providers
    }

    report.providers.push(providerReport);
  }

  // Check if we have any data to sync
  if (mergedGroups.length === 0) {
    logError("No groups collected from any provider, aborting sync");
    report.success = false;
    report.errors.push({
      phase: "collect",
      message: "No groups collected from any provider",
    });
    return report;
  }

  // ==========================================================================
  // Phase 2: Build merged options
  // ==========================================================================

  logInfo("\n[Merging data]");
  logInfo(`Total groups: ${mergedGroups.length}`);
  logInfo(`Total models: ${mergedModels.size}`);

  // GroupRatio
  const groupRatio = Object.fromEntries(
    mergedGroups.map((g) => [g.name, g.ratio])
  );

  // AutoGroups (sorted by ratio, cheapest first)
  const autoGroups = [...mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((g) => g.name);

  // UserUsableGroups
  const usableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)",
  };
  for (const group of mergedGroups) {
    usableGroups[group.name] = group.description;
  }

  // ModelRatio
  const modelRatio = Object.fromEntries(
    [...mergedModels.entries()].map(([k, v]) => [k, v.ratio])
  );

  // CompletionRatio
  const completionRatio = Object.fromEntries(
    [...mergedModels.entries()].map(([k, v]) => [k, v.completionRatio])
  );

  // ==========================================================================
  // Phase 3: Update target options
  // ==========================================================================

  logInfo("\n[Updating target options]");
  const target = new TargetClient(config.target);

  const optionsResult = await target.updateOptions({
    GroupRatio: JSON.stringify(groupRatio),
    UserUsableGroups: JSON.stringify(usableGroups),
    AutoGroups: JSON.stringify(autoGroups),
    DefaultUseAutoGroup: "true",
    ModelRatio: JSON.stringify(modelRatio),
    CompletionRatio: JSON.stringify(completionRatio),
  });

  report.options.updated = optionsResult.updated;
  if (optionsResult.failed.length > 0) {
    for (const key of optionsResult.failed) {
      report.errors.push({
        phase: "options",
        message: `Failed to update option: ${key}`,
      });
    }
  }

  // ==========================================================================
  // Phase 4: Sync channels (upsert + delete stale)
  // ==========================================================================

  logInfo("\n[Syncing channels]");

  // Get existing channels
  const existingChannels = await target.listChannels();
  const existingByName = new Map(existingChannels.map((c) => [c.name, c]));

  // Track which channel names we want to keep
  const desiredChannelNames = new Set(channelsToCreate.map((c) => c.name));

  // Upsert channels
  for (const spec of channelsToCreate) {
    const existing = existingByName.get(spec.name);
  const channelData: Channel = {
      name: spec.name,
      type: spec.type,
      key: spec.key,
      base_url: spec.baseUrl.replace(/\/$/, ""),
      models: spec.models.join(","),
      group: spec.group,
      priority: spec.priority,
      status: 1,
      tag: spec.provider,
    };

    if (existing) {
      // Update existing channel
      channelData.id = existing.id;
      const success = await target.updateChannel(channelData);
      if (success) {
        report.channels.updated++;
      } else {
        report.errors.push({
          phase: "channels",
          message: `Failed to update channel: ${spec.name}`,
        });
      }
    } else {
      // Create new channel
      const id = await target.createChannel(channelData);
      if (id !== null) {
        report.channels.created++;
      } else {
        report.errors.push({
          phase: "channels",
          message: `Failed to create channel: ${spec.name}`,
        });
      }
    }
  }

  // Provider names for tag-based deletion
  const configuredProviders = new Set(config.providers.map((p) => p.name));

  // Delete stale channels (channels with tags not in current config)
  if (config.options?.deleteStaleChannels !== false) {
    for (const channel of existingChannels) {
      if (desiredChannelNames.has(channel.name)) continue;

      // Delete if channel has a tag that's not in current providers
      if (channel.tag && !configuredProviders.has(channel.tag)) {
        logInfo(`Deleting channel from removed provider "${channel.tag}": ${channel.name}`);
        const success = await target.deleteChannel(channel.id!);
        if (success) {
          report.channels.deleted++;
        } else {
          report.errors.push({
            phase: "channels",
            message: `Failed to delete stale channel: ${channel.name}`,
          });
        }
      }
    }
  }

  // ==========================================================================
  // Phase 5: Sync models (create missing)
  // ==========================================================================

  logInfo("\n[Syncing models]");

  const existingModels = await target.listModels();
  const existingModelNames = new Set(existingModels.map((m) => m.model_name));
  logInfo(`Found ${existingModels.length} existing models on target`);

  // Only sync models from enabled groups, not all upstream models
  const modelsToSync = new Set<string>();
  for (const channel of channelsToCreate) {
    for (const model of channel.models) {
      modelsToSync.add(model);
    }
  }

  logInfo(`Models to sync from enabled groups: ${modelsToSync.size}`);

  let modelsCreated = 0;
  for (const modelName of modelsToSync) {
    if (!existingModelNames.has(modelName)) {
      // Find model info from upstream
      const modelInfo = upstreamModels.find((m) => m.name === modelName);
      const success = await target.createModel({
        model_name: modelName,
        vendor_id: modelInfo?.vendorId,
        status: 1,
        sync_official: 1,
      });
      if (success) {
        modelsCreated++;
      }
    } else {
      logInfo(`  Model already exists: ${modelName}`);
    }
  }

  logInfo(`Models: ${modelsCreated} created`);

  // ==========================================================================
  // Phase 6: Summary
  // ==========================================================================

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  report.success = report.errors.length === 0;

  logInfo("\n" + "=".repeat(60));
  logInfo("Sync complete!");
  logInfo("=".repeat(60));
  logInfo(
    `Providers: ${report.providers.filter((p) => p.success).length} success, ${report.providers.filter((p) => !p.success).length} failed`
  );
  logInfo(
    `Channels: ${report.channels.created} created, ${report.channels.updated} updated, ${report.channels.deleted} deleted`
  );
  logInfo(`Options: ${report.options.updated.length} updated`);
  logInfo(`Time: ${elapsed}s`);

  if (report.errors.length > 0) {
    logInfo(`\nErrors (${report.errors.length}):`);
    for (const err of report.errors) {
      logError(`  [${err.provider ?? "target"}/${err.phase}] ${err.message}`);
    }
  }

  return report;
}
