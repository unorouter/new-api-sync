import { NekoClient } from "@/clients/neko-client";
import { NewApiClient } from "@/clients/newapi-client";
import {
  calculatePriorityBonus,
  inferVendorFromModelName,
  isTextModel,
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@/lib/constants";
import type {
  Channel,
  ChannelSpec,
  Config,
  GroupInfo,
  MergedGroup,
  MergedModel,
  NekoProviderConfig,
  ProviderConfig,
  ProviderReport,
  SyncReport,
} from "@/lib/types";
import { consola } from "consola";

export class SyncService {
  private mergedGroups: MergedGroup[] = [];
  private mergedModels = new Map<string, MergedModel>();
  private modelEndpoints = new Map<string, string[]>();
  private channelsToCreate: ChannelSpec[] = [];

  constructor(private config: Config) {}

  private groupHasEnabledVendor(group: GroupInfo, enabledVendors: string[]): boolean {
    const vendorSet = new Set(enabledVendors.map((v) => v.toLowerCase()));
    return group.models.some((modelName) => {
      const vendor = inferVendorFromModelName(modelName);
      return vendor && vendorSet.has(vendor);
    });
  }

  private async processProvider(
    providerConfig: ProviderConfig | NekoProviderConfig,
    report: SyncReport,
  ): Promise<ProviderReport> {
    const providerReport: ProviderReport = {
      name: providerConfig.name,
      success: false,
      groups: 0,
      models: 0,
      tokens: { created: 0, existing: 0, deleted: 0 },
    };

    try {
      const upstream =
        providerConfig.type === "neko"
          ? new NekoClient(providerConfig as NekoProviderConfig)
          : new NewApiClient(providerConfig as ProviderConfig);

      const startBalance = await upstream.fetchBalance();
      const pricing = await upstream.fetchPricing();
      consola.info(`[${providerConfig.name}] Balance: ${startBalance}`);
      let currentBalance = parseFloat(startBalance.replace(/[^0-9.-]/g, ""));

      // Populate model endpoints map for text model detection
      for (const model of pricing.models) {
        if (model.supportedEndpoints?.length) {
          this.modelEndpoints.set(model.name, model.supportedEndpoints);
        }
      }

      // Find groups with Anthropic models that aren't in config
      const anthropicModels = new Set(
        pricing.models
          .filter((m) => m.name.toLowerCase().includes("claude") || m.vendorId === 2)
          .map((m) => m.name),
      );
      const enabledSet = new Set(providerConfig.enabledGroups ?? []);
      const suggestedGroups = pricing.groups.filter((g) => {
        const hasAnthropicModel = g.models.some((m) => anthropicModels.has(m));
        const notEnabled = !enabledSet.has(g.name);
        return hasAnthropicModel && notEnabled;
      });

      if (suggestedGroups.length > 0 && providerConfig.enabledGroups?.length) {
        consola.info(
          `[${providerConfig.name}] Groups with Claude models (not in config): ${suggestedGroups.map((g) => g.name).join(", ")}`,
        );
      }

      let groups: GroupInfo[] = pricing.groups;

      // Filter by enabledGroups if specified
      if (providerConfig.enabledGroups?.length) {
        groups = groups.filter((g) => providerConfig.enabledGroups!.includes(g.name));
      }

      // Filter by enabledVendors if specified
      if (providerConfig.enabledVendors?.length) {
        groups = groups.filter((g) =>
          this.groupHasEnabledVendor(g, providerConfig.enabledVendors!),
        );
      }

      // Apply global blacklist to groups (by name or description)
      if (this.config.blacklist?.length) {
        groups = groups.filter(
          (g) =>
            !matchesBlacklist(g.name, this.config.blacklist) &&
            !matchesBlacklist(g.description, this.config.blacklist),
        );
      }

      const tokenResult = await upstream.ensureTokens(groups, providerConfig.name);
      providerReport.tokens = {
        created: tokenResult.created,
        existing: tokenResult.existing,
        deleted: tokenResult.deleted,
      };

      // Track groups with no working models to delete their tokens later
      const groupsWithNoWorkingModels: string[] = [];
      let totalTestCost = 0;

      for (const group of groups) {
        const originalName = `${group.name}-${providerConfig.name}`;
        const sanitizedName = sanitizeGroupName(originalName);
        let groupRatio = group.ratio;

        // Always filter out non-text models and blacklisted models first
        let workingModels = group.models.filter(
          (modelName) =>
            isTextModel(modelName, undefined, this.modelEndpoints) &&
            !matchesBlacklist(modelName, this.config.blacklist),
        );

        // Then filter by enabled vendors if specified
        if (providerConfig.enabledVendors?.length) {
          const vendorSet = new Set(providerConfig.enabledVendors.map((v) => v.toLowerCase()));
          workingModels = workingModels.filter((modelName) => {
            const vendor = inferVendorFromModelName(modelName);
            return vendor && vendorSet.has(vendor);
          });
        }

        // Filter by enabled models if specified (glob patterns supported)
        if (providerConfig.enabledModels?.length) {
          workingModels = workingModels.filter((modelName) =>
            matchesAnyPattern(modelName, providerConfig.enabledModels!),
          );
        }

        // Skip group if no models match filters
        if (workingModels.length === 0) {
          continue;
        }

        // Test models
        let avgResponseTime: number | undefined;
        const apiKey = tokenResult.tokens[group.name] ?? "";
        if (apiKey) {
          const testResult = await upstream.testModelsWithKey(
            apiKey,
            workingModels,
            group.channelType,
          );
          workingModels = testResult.workingModels;
          avgResponseTime = testResult.avgResponseTime;

          // Calculate test cost by fetching new balance
          const newBalanceStr = await upstream.fetchBalance();
          const newBalance = parseFloat(newBalanceStr.replace(/[^0-9.-]/g, ""));
          const testCost = currentBalance - newBalance;
          if (testCost > 0) {
            totalTestCost += testCost;
            currentBalance = newBalance;
          }

          const testedCount = workingModels.length + (group.models.length - workingModels.length);
          const bonus = calculatePriorityBonus(avgResponseTime);
          const msStr = avgResponseTime !== undefined ? `${Math.round(avgResponseTime)}ms` : "-";

          if (workingModels.length === 0) {
            consola.info(
              `[${providerConfig.name}/${group.name}] 0/${testedCount} | ${msStr} | $${testCost.toFixed(4)} | skip`,
            );
            groupsWithNoWorkingModels.push(group.name);
            continue;
          }

          consola.info(
            `[${providerConfig.name}/${group.name}] ${workingModels.length}/${testedCount} | ${msStr} → +${bonus} | $${testCost.toFixed(4)}`,
          );
        }

        // Apply priceMultiplier to group ratio for per-provider billing
        if (providerConfig.priceMultiplier) {
          groupRatio *= providerConfig.priceMultiplier;
        }

        // Calculate dynamic priority and weight: faster response = higher values
        const basePriority = providerConfig.priority ?? 0;
        const responseBonus = calculatePriorityBonus(avgResponseTime);
        const dynamicPriority = basePriority + responseBonus;
        const dynamicWeight = responseBonus > 0 ? responseBonus : 1;

        this.mergedGroups.push({
          name: sanitizedName,
          ratio: groupRatio,
          description: `${sanitizeGroupName(group.name)} via ${providerConfig.name}`,
          provider: providerConfig.name,
        });
        this.channelsToCreate.push({
          name: sanitizedName,
          type: group.channelType,
          key: tokenResult.tokens[group.name] ?? "",
          baseUrl: providerConfig.baseUrl,
          models: workingModels,
          group: sanitizedName,
          priority: dynamicPriority,
          weight: dynamicWeight,
          provider: providerConfig.name,
          remark: originalName,
        });
      }

      // Delete tokens for groups with no working models
      for (const groupName of groupsWithNoWorkingModels) {
        const tokenName = `${groupName}-${providerConfig.name}`;
        const deleted = await upstream.deleteTokenByName(tokenName);
        if (deleted) {
          providerReport.tokens.deleted++;
        }
      }

      for (const model of pricing.models) {
        const existing = this.mergedModels.get(model.name);
        if (!existing || model.ratio < existing.ratio) {
          this.mergedModels.set(model.name, {
            ratio: model.ratio,
            completionRatio: model.completionRatio,
          });
        }
      }

      providerReport.groups = groups.length;
      providerReport.models = pricing.models.length;
      providerReport.success = true;

      // Log final balance and total test cost
      if (totalTestCost > 0) {
        const finalBalance = await upstream.fetchBalance();
        consola.info(
          `[${providerConfig.name}] Final balance: ${finalBalance} | Total test cost: $${totalTestCost.toFixed(4)}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerReport.error = message;
      report.errors.push({
        provider: providerConfig.name,
        phase: "fetch",
        message,
      });
      consola.error(`Provider ${providerConfig.name} failed: ${message}`);
    }

    return providerReport;
  }

  private async syncToTarget(report: SyncReport): Promise<{ modelsCreated: number; modelsUpdated: number; modelsDeleted: number; orphansDeleted: number }> {
    const groupRatio = Object.fromEntries(this.mergedGroups.map((g) => [g.name, g.ratio]));
    const autoGroups = [...this.mergedGroups].sort((a, b) => a.ratio - b.ratio).map((g) => g.name);
    const usableGroups: Record<string, string> = {
      auto: "Auto (Smart Routing with Failover)",
    };
    for (const group of this.mergedGroups) {
      usableGroups[group.name] = group.description;
    }
    const modelRatio = Object.fromEntries(
      [...this.mergedModels.entries()].map(([k, v]) => [k, v.ratio]),
    );
    const completionRatio = Object.fromEntries(
      [...this.mergedModels.entries()].map(([k, v]) => [k, v.completionRatio]),
    );

    const target = new NewApiClient(this.config.target);

    const optionsResult = await target.updateOptions({
      GroupRatio: JSON.stringify(groupRatio),
      UserUsableGroups: JSON.stringify(usableGroups),
      AutoGroups: JSON.stringify(autoGroups),
      DefaultUseAutoGroup: "true",
      ModelRatio: JSON.stringify(modelRatio),
      CompletionRatio: JSON.stringify(completionRatio),
    });

    report.options.updated = optionsResult.updated;
    for (const key of optionsResult.failed) {
      report.errors.push({
        phase: "options",
        message: `Failed to update option: ${key}`,
      });
    }

    const existingChannels = await target.listChannels();
    const existingByName = new Map(existingChannels.map((c) => [c.name, c]));
    const desiredChannelNames = new Set(this.channelsToCreate.map((c) => c.name));

    for (const spec of this.channelsToCreate) {
      const existing = existingByName.get(spec.name);
      const channelData: Channel = {
        name: spec.name,
        type: spec.type,
        key: spec.key,
        base_url: spec.baseUrl.replace(/\/$/, ""),
        models: spec.models.join(","),
        group: spec.group,
        priority: spec.priority,
        weight: spec.weight,
        status: 1,
        tag: spec.provider,
        remark: spec.remark,
      };

      if (existing) {
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

    // Delete stale channels (managed by sync but no longer needed)
    for (const channel of existingChannels) {
      if (desiredChannelNames.has(channel.name)) continue;
      if (channel.tag) {
        const success = await target.deleteChannel(channel.id!);
        if (success) {
          report.channels.deleted++;
        } else {
          report.errors.push({
            phase: "channels",
            message: `Failed to delete channel: ${channel.name}`,
          });
        }
      }
    }

    const existingModels = await target.listModels();
    const existingModelsByName = new Map(existingModels.map((m) => [m.model_name, m]));
    const modelsToSync = new Set<string>();
    for (const channel of this.channelsToCreate) {
      for (const model of channel.models) {
        modelsToSync.add(model);
      }
    }

    const targetVendors = await target.listVendors();
    const vendorNameToTargetId: Record<string, number> = {};
    for (const v of targetVendors) {
      vendorNameToTargetId[v.name.toLowerCase()] = v.id;
    }

    let modelsCreated = 0;
    let modelsUpdated = 0;
    for (const modelName of modelsToSync) {
      const inferredVendor = inferVendorFromModelName(modelName);
      const targetVendorId = inferredVendor ? vendorNameToTargetId[inferredVendor] : undefined;

      const existing = existingModelsByName.get(modelName);
      if (existing) {
        if (existing.vendor_id !== targetVendorId) {
          const success = await target.updateModel({
            ...existing,
            vendor_id: targetVendorId,
          });
          if (success) {
            modelsUpdated++;
          }
        }
      } else {
        const success = await target.createModel({
          model_name: modelName,
          vendor_id: targetVendorId,
          status: 1,
          sync_official: 1,
        });
        if (success) {
          modelsCreated++;
        }
      }
    }

    let modelsDeleted = 0;
    for (const model of existingModels) {
      if (model.sync_official === 1 && !modelsToSync.has(model.model_name)) {
        if (model.id && (await target.deleteModel(model.id))) {
          modelsDeleted++;
        }
      }
    }

    // Cleanup orphaned models directly from database (models not bound to any channel)
    const orphansDeleted = await target.cleanupOrphanedModels();

    return { modelsCreated, modelsUpdated, modelsDeleted, orphansDeleted };
  }

  async sync(): Promise<SyncReport> {
    const startTime = Date.now();

    const report: SyncReport = {
      success: true,
      providers: [],
      channels: { created: 0, updated: 0, deleted: 0 },
      options: { updated: [] },
      errors: [],
      timestamp: new Date(),
    };

    // Process all providers
    for (const providerConfig of this.config.providers) {
      const providerReport = await this.processProvider(providerConfig, report);
      report.providers.push(providerReport);
    }

    if (this.mergedGroups.length === 0) {
      consola.error("No groups collected from any provider");
      report.success = false;
      report.errors.push({ phase: "collect", message: "No groups collected" });
      return report;
    }

    // Sync to target
    const { modelsCreated, modelsUpdated, modelsDeleted, orphansDeleted } =
      await this.syncToTarget(report);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    report.success = report.errors.length === 0;

    const orphanStr = orphansDeleted > 0 ? ` | Orphans: -${orphansDeleted}` : "";
    consola.success(
      `Done in ${elapsed}s | Providers: ${report.providers.filter((p) => p.success).length}/${report.providers.length} | Channels: +${report.channels.created} ~${report.channels.updated} -${report.channels.deleted} | Models: +${modelsCreated} ~${modelsUpdated} -${modelsDeleted}${orphanStr}`,
    );

    if (report.errors.length > 0) {
      for (const err of report.errors) {
        consola.error(`[${err.provider ?? "target"}/${err.phase}] ${err.message}`);
      }
    }

    return report;
  }
}

// Convenience function for backwards compatibility
export async function sync(config: Config): Promise<SyncReport> {
  return new SyncService(config).sync();
}
