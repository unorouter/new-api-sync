import { NewApiClient } from "@/clients/newapi-client";
import { inferVendorFromModelName } from "@/lib/constants";
import type { Channel, Config, SyncReport } from "@/lib/types";
import { consola } from "consola";
import type { SyncState } from "./types";

export async function syncToTarget(
  config: Config,
  state: SyncState,
  report: SyncReport,
): Promise<{ modelsCreated: number; modelsUpdated: number; modelsDeleted: number; orphansDeleted: number }> {
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const groupRatio = Object.fromEntries(state.mergedGroups.map((g) => [g.name, round(g.ratio)]));
  const autoGroups = [...state.mergedGroups].sort((a, b) => a.ratio - b.ratio).map((g) => g.name);
  const usableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)",
  };
  for (const group of state.mergedGroups) {
    usableGroups[group.name] = group.description;
  }
  const modelRatio = Object.fromEntries(
    [...state.mergedModels.entries()].map(([k, v]) => [k, round(v.ratio)]),
  );
  const completionRatio = Object.fromEntries(
    [...state.mergedModels.entries()].map(([k, v]) => [k, round(v.completionRatio)]),
  );

  const target = new NewApiClient(config.target);

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
  const desiredChannelNames = new Set(state.channelsToCreate.map((c) => c.name));

  for (const spec of state.channelsToCreate) {
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
  for (const channel of state.channelsToCreate) {
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

  // Delete models that are mapping sources (they've been remapped to something else)
  if (config.modelMapping) {
    const mappingSources = new Set(Object.keys(config.modelMapping));
    for (const model of existingModels) {
      if (mappingSources.has(model.model_name)) {
        if (model.id && (await target.deleteModel(model.id))) {
          modelsDeleted++;
          consola.info(`Deleted mapped model: ${model.model_name}`);
        }
      }
    }
  }

  // Cleanup orphaned models directly from database (models not bound to any channel)
  const orphansDeleted = await target.cleanupOrphanedModels();

  return { modelsCreated, modelsUpdated, modelsDeleted, orphansDeleted };
}
