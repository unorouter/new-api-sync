import { NekoClient } from "@/clients/neko-client";
import { TargetClient } from "@/clients/target-client";
import { NewApiClient } from "@/clients/newapi-client";
import { validateConfig } from "@/lib/config";
import { logInfo, sanitizeGroupName } from "@/lib/utils";
import type {
  AnyProviderConfig,
  Channel,
  Config,
  GroupInfo,
  MergedGroup,
  MergedModel,
  ModelInfo,
  NekoProviderConfig,
  ProviderConfig,
  ProviderReport,
  SyncReport,
} from "@/types";
import { isNekoProvider } from "@/types";

export async function sync(config: Config): Promise<SyncReport> {
  const startTime = Date.now();
  validateConfig(config);

  const report: SyncReport = {
    success: true,
    providers: [],
    channels: { created: 0, updated: 0, deleted: 0 },
    options: { updated: [] },
    errors: [],
    timestamp: new Date(),
  };

  const mergedGroups: MergedGroup[] = [];
  const mergedModels = new Map<string, MergedModel>();
  const upstreamModels: ModelInfo[] = [];
  const upstreamVendorIdToName: Record<number, string> = {};
  const channelsToCreate: Array<{
    name: string;
    type: number;
    key: string;
    baseUrl: string;
    models: string[];
    group: string;
    priority: number;
    provider: string;
    remark: string;
  }> = [];

  for (const providerConfig of config.providers) {
    const providerReport: ProviderReport = {
      name: providerConfig.name,
      success: false,
      groups: 0,
      models: 0,
      tokens: { created: 0, existing: 0, deleted: 0 },
    };

    try {
      const isNeko = isNekoProvider(providerConfig);
      const upstream = isNeko
        ? new NekoClient(providerConfig as NekoProviderConfig)
        : new NewApiClient(providerConfig as ProviderConfig);
      const pricing = await upstream.fetchPricing();

      let groups: GroupInfo[];
      if (providerConfig.enabledGroups?.length) {
        groups = pricing.groups.filter((g) =>
          providerConfig.enabledGroups!.includes(g.name),
        );
      } else {
        groups = pricing.groups;
      }

      const tokenResult = await upstream.ensureTokens(
        groups,
        providerConfig.name,
      );
      providerReport.tokens = {
        created: tokenResult.created,
        existing: tokenResult.existing,
        deleted: tokenResult.deleted,
      };

      for (const group of groups) {
        const originalName = `${group.name}-${providerConfig.name}`;
        const sanitizedName = sanitizeGroupName(originalName);
        let groupRatio = group.ratio;
        let workingModels = group.models;

        // Test models if option is enabled
        if (config.options?.testModels) {
          const apiKey = tokenResult.tokens[group.name] ?? "";
          if (apiKey) {
            workingModels = await upstream.testModelsWithKey(
              apiKey,
              group.models,
              group.channelType,
            );
            const failedCount = group.models.length - workingModels.length;
            if (failedCount > 0) {
              logInfo(
                `[${providerConfig.name}/${group.name}] ${failedCount}/${group.models.length} models failed testing`,
              );
            }
            if (workingModels.length === 0) {
              logInfo(
                `[${providerConfig.name}/${group.name}] Skipping - no working models`,
              );
              continue;
            }
          }
        }

        // Apply priceMultiplier to group ratio for per-provider billing
        if (providerConfig.priceMultiplier) {
          groupRatio *= providerConfig.priceMultiplier;
        }

        mergedGroups.push({
          name: sanitizedName,
          ratio: groupRatio,
          description: `${group.description} [${providerConfig.name}]`,
          provider: providerConfig.name,
        });
        channelsToCreate.push({
          name: sanitizedName,
          type: group.channelType,
          key: tokenResult.tokens[group.name] ?? "",
          baseUrl: providerConfig.baseUrl,
          models: workingModels,
          group: sanitizedName,
          priority: providerConfig.priority ?? 0,
          provider: providerConfig.name,
          remark: originalName,
        });
      }

      for (const model of pricing.models) {
        const existing = mergedModels.get(model.name);
        if (!existing || model.ratio < existing.ratio) {
          mergedModels.set(model.name, {
            ratio: model.ratio,
            completionRatio: model.completionRatio,
          });
        }
        if (!upstreamModels.find((m) => m.name === model.name)) {
          upstreamModels.push(model);
        }
      }

      Object.assign(upstreamVendorIdToName, pricing.vendorIdToName);

      providerReport.groups = groups.length;
      providerReport.models = pricing.models.length;
      providerReport.success = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerReport.error = message;
      report.errors.push({
        provider: providerConfig.name,
        phase: "fetch",
        message,
      });
      console.error(`Provider ${providerConfig.name} failed: ${message}`);
    }

    report.providers.push(providerReport);
  }

  if (mergedGroups.length === 0) {
    console.error("No groups collected from any provider");
    report.success = false;
    report.errors.push({ phase: "collect", message: "No groups collected" });
    return report;
  }

  const groupRatio = Object.fromEntries(
    mergedGroups.map((g) => [g.name, g.ratio]),
  );
  const autoGroups = [...mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((g) => g.name);
  const usableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)",
  };
  for (const group of mergedGroups) {
    usableGroups[group.name] = group.description;
  }
  const modelRatio = Object.fromEntries(
    [...mergedModels.entries()].map(([k, v]) => [k, v.ratio]),
  );
  const completionRatio = Object.fromEntries(
    [...mergedModels.entries()].map(([k, v]) => [k, v.completionRatio]),
  );

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
  for (const key of optionsResult.failed) {
    report.errors.push({
      phase: "options",
      message: `Failed to update option: ${key}`,
    });
  }

  const existingChannels = await target.listChannels();
  const existingByName = new Map(existingChannels.map((c) => [c.name, c]));
  const desiredChannelNames = new Set(channelsToCreate.map((c) => c.name));

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

  const configuredProviders = new Set(config.providers.map((p) => p.name));

  if (config.options?.deleteStaleChannels !== false) {
    for (const channel of existingChannels) {
      if (desiredChannelNames.has(channel.name)) continue;
      // Delete if: channel has a tag (managed by sync) AND either:
      // 1. Tag matches a configured provider (stale channel from current provider)
      // 2. Tag doesn't match any configured provider (orphan from removed provider)
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
  }

  const existingModels = await target.listModels();
  const existingModelsByName = new Map(existingModels.map((m) => [m.model_name, m]));
  const modelsToSync = new Set<string>();
  for (const channel of channelsToCreate) {
    for (const model of channel.models) {
      modelsToSync.add(model);
    }
  }

  const targetVendors = await target.listVendors();
  const vendorNameToTargetId: Record<string, number> = {};
  for (const v of targetVendors) {
    vendorNameToTargetId[v.name.toLowerCase()] = v.id;
  }

  // Map upstream vendor names to target vendor names
  const vendorNameMapping: Record<string, string> = {
    gemini: "google",
    grok: "xai",
  };

  let modelsCreated = 0;
  let modelsUpdated = 0;
  for (const modelName of modelsToSync) {
    const modelInfo = upstreamModels.find((m) => m.name === modelName);
    const upstreamVendorName = modelInfo?.vendorId
      ? upstreamVendorIdToName[modelInfo.vendorId]
      : undefined;
    const mappedVendorName = upstreamVendorName
      ? (vendorNameMapping[upstreamVendorName.toLowerCase()] ?? upstreamVendorName.toLowerCase())
      : undefined;
    const targetVendorId = mappedVendorName
      ? vendorNameToTargetId[mappedVendorName]
      : undefined;

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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  report.success = report.errors.length === 0;

  console.log(
    `Done in ${elapsed}s | Providers: ${report.providers.filter((p) => p.success).length}/${report.providers.length} | Channels: +${report.channels.created} ~${report.channels.updated} -${report.channels.deleted} | Models: +${modelsCreated} ~${modelsUpdated} -${modelsDeleted}`,
  );

  if (report.errors.length > 0) {
    for (const err of report.errors) {
      console.error(`[${err.provider ?? "target"}/${err.phase}] ${err.message}`);
    }
  }

  return report;
}
