import { inferVendorFromModelName } from "@/lib/constants";
import type { Channel, Config, SyncReport, SyncState } from "@/lib/types";
import { NewApiClient } from "@/providers/newapi/client";
import { consola } from "consola";

const ENDPOINT_DEFAULT_PATHS: Record<string, string> = {
  openai: "/v1/chat/completions",
  "openai-response": "/v1/responses",
  "openai-response-compact": "/v1/responses/compact",
  anthropic: "/v1/messages",
  gemini: "/v1beta/models/{model}:generateContent",
  "jina-rerank": "/v1/rerank",
  "image-generation": "/v1/images/generations",
  embedding: "/v1/embeddings"
};

/**
 * Build the `endpoints` JSON string for a model from its upstream endpoint types.
 * Returns undefined when no endpoint data is available (let new-api use defaults).
 */
function buildModelEndpoints(endpointTypes: string[]): string | undefined {
  const obj: Record<string, string> = {};
  for (const ep of endpointTypes) {
    const path = ENDPOINT_DEFAULT_PATHS[ep];
    if (path) obj[ep] = path;
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : undefined;
}

export async function syncToTarget(
  config: Config,
  state: SyncState,
  report: SyncReport
): Promise<{
  modelsCreated: number;
  modelsUpdated: number;
  modelsDeleted: number;
  orphansDeleted: number;
}> {
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const groupRatio = Object.fromEntries(
    state.mergedGroups.map((g) => [g.name, round(g.ratio)])
  );
  const autoGroups = [...state.mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((g) => g.name);
  const usableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)"
  };
  for (const group of state.mergedGroups) {
    usableGroups[group.name] = group.description;
  }
  const modelRatio = Object.fromEntries(
    [...state.mergedModels.entries()].map(([k, v]) => [k, round(v.ratio)])
  );
  const completionRatio = Object.fromEntries(
    [...state.mergedModels.entries()].map(([k, v]) => [
      k,
      round(v.completionRatio)
    ])
  );

  const target = new NewApiClient(config.target);

  // Always merge options into existing target values so synced models
  // get proper pricing without overwriting unmanaged data
  const existingOptions = await target.getOptions([
    "ModelRatio",
    "CompletionRatio",
    "GroupRatio",
    "UserUsableGroups",
    "AutoGroups"
  ]);
  const parse = <T>(val: string | undefined, fallback: T): T => {
    try {
      return val ? JSON.parse(val) : fallback;
    } catch {
      return fallback;
    }
  };

  const mergedModelRatio = {
    ...parse<Record<string, number>>(existingOptions.ModelRatio, {}),
    ...modelRatio
  };
  const mergedCompletionRatio = {
    ...parse<Record<string, number>>(existingOptions.CompletionRatio, {}),
    ...completionRatio
  };
  const mergedGroupRatio = {
    ...parse<Record<string, number>>(existingOptions.GroupRatio, {}),
    ...groupRatio
  };
  const mergedUsableGroups = {
    ...parse<Record<string, string>>(existingOptions.UserUsableGroups, {}),
    ...usableGroups
  };
  const mergedAutoGroups = [
    ...new Set([
      ...parse<string[]>(existingOptions.AutoGroups, []),
      ...autoGroups
    ])
  ];

  {
    const optionsResult = await target.updateOptions({
      GroupRatio: JSON.stringify(mergedGroupRatio),
      UserUsableGroups: JSON.stringify(mergedUsableGroups),
      AutoGroups: JSON.stringify(mergedAutoGroups),
      DefaultUseAutoGroup: "true",
      ModelRatio: JSON.stringify(mergedModelRatio),
      CompletionRatio: JSON.stringify(mergedCompletionRatio)
    });

    report.options.updated = optionsResult.updated;
    for (const key of optionsResult.failed) {
      report.errors.push({
        phase: "options",
        message: `Failed to update option: ${key}`
      });
    }
  }

  const existingChannels = await target.listChannels();
  const existingByName = new Map(existingChannels.map((c) => [c.name, c]));
  const desiredChannelNames = new Set(
    state.channelsToCreate.map((c) => c.name)
  );

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
      remark: spec.remark
    };

    if (existing) {
      channelData.id = existing.id;
      const success = await target.updateChannel(channelData);
      if (success) {
        report.channels.updated++;
      } else {
        report.errors.push({
          phase: "channels",
          message: `Failed to update channel: ${spec.name}`
        });
      }
    } else {
      const id = await target.createChannel(channelData);
      if (id !== null) {
        report.channels.created++;
      } else {
        report.errors.push({
          phase: "channels",
          message: `Failed to create channel: ${spec.name}`
        });
      }
    }
  }

  // Delete stale channels (managed by sync but no longer needed)
  for (const channel of existingChannels) {
    if (desiredChannelNames.has(channel.name)) continue;
    if (!channel.tag) continue;
    // In partial mode, only touch channels belonging to active providers
    if (config.onlyProviders && !config.onlyProviders.has(channel.tag))
      continue;
    const success = await target.deleteChannel(channel.id!);
    if (success) {
      report.channels.deleted++;
    } else {
      report.errors.push({
        phase: "channels",
        message: `Failed to delete channel: ${channel.name}`
      });
    }
  }

  const existingModels = await target.listModels();
  const existingModelsByName = new Map(
    existingModels.map((m) => [m.model_name, m])
  );
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
  // Add common aliases for vendor names so inference matches target entries
  const VENDOR_ALIASES: Record<string, string[]> = {
    zhipu: ["智谱", "zhipu ai", "chatglm"],
    moonshot: ["月之暗面", "kimi"],
    baidu: ["百度", "文心"],
    xunfei: ["讯飞", "spark"],
    alibaba: ["阿里", "通义", "qwen"],
    tencent: ["腾讯", "混元"],
    bytedance: ["字节", "豆包", "doubao"]
  };
  for (const [canonical, aliases] of Object.entries(VENDOR_ALIASES)) {
    if (vendorNameToTargetId[canonical] !== undefined) continue;
    for (const alias of aliases) {
      const match = targetVendors.find((v) =>
        v.name.toLowerCase().includes(alias.toLowerCase())
      );
      if (match) {
        vendorNameToTargetId[canonical] = match.id;
        break;
      }
    }
  }

  let modelsCreated = 0;
  let modelsUpdated = 0;
  for (const modelName of modelsToSync) {
    const inferredVendor = inferVendorFromModelName(modelName);
    const targetVendorId = inferredVendor
      ? vendorNameToTargetId[inferredVendor]
      : undefined;

    const existing = existingModelsByName.get(modelName);
    const upstreamEndpoints = state.modelEndpoints.get(modelName);
    const endpoints = upstreamEndpoints
      ? buildModelEndpoints(upstreamEndpoints)
      : undefined;

    if (existing) {
      const needsUpdate =
        existing.vendor_id !== targetVendorId ||
        existing.endpoints !== (endpoints ?? existing.endpoints);
      if (needsUpdate) {
        const success = await target.updateModel({
          ...existing,
          vendor_id: targetVendorId,
          endpoints: endpoints ?? existing.endpoints
        });
        if (success) {
          modelsUpdated++;
        }
      }
    } else {
      const success = await target.createModel({
        model_name: modelName,
        vendor_id: targetVendorId,
        endpoints,
        status: 1,
        sync_official: 1
      });
      if (success) {
        modelsCreated++;
      }
    }
  }

  // In partial mode, protect models that belong to non-active providers' channels
  let protectedModels: Set<string> | undefined;
  if (config.onlyProviders) {
    protectedModels = new Set<string>();
    for (const channel of existingChannels) {
      if (!channel.tag || config.onlyProviders.has(channel.tag)) continue;
      if (channel.models) {
        for (const model of channel.models.split(",")) {
          protectedModels.add(model.trim());
        }
      }
    }
  }

  let modelsDeleted = 0;
  for (const model of existingModels) {
    if (modelsToSync.has(model.model_name)) continue;
    if (protectedModels?.has(model.model_name)) continue;

    // Clean up sync-managed models that are no longer needed
    if (model.sync_official === 1) {
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
