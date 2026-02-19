import type { RuntimeConfig } from "@/config";
import { VENDOR_MATCHERS } from "@/lib/constants";
import type {
  Channel,
  DesiredModelSpec,
  DesiredState,
  DiffOperation,
  ModelMeta,
  SyncDiff,
  TargetSnapshot,
  Vendor,
} from "@/lib/types";

const DEFAULT_AUTO_LABEL = "Auto (Smart Routing with Failover)";

function stableObject<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function parseJsonObject<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeChannelForCompare(channel: Channel): Omit<Channel, "id"> {
  return {
    name: channel.name,
    type: channel.type,
    key: channel.key,
    base_url: channel.base_url.replace(/\/$/, ""),
    models: channel.models,
    group: channel.group,
    priority: channel.priority,
    weight: channel.weight,
    status: channel.status,
    tag: channel.tag,
    remark: channel.remark,
  };
}

function channelChanged(existing: Channel, desired: Channel): boolean {
  const a = normalizeChannelForCompare(existing);
  const b = normalizeChannelForCompare(desired);
  return JSON.stringify(a) !== JSON.stringify(b);
}

function mapVendorIds(vendors: Vendor[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const vendor of vendors) {
    map[vendor.name.toLowerCase()] = vendor.id;
  }

  for (const [canonical, matcher] of Object.entries(VENDOR_MATCHERS)) {
    const names = matcher.nameAliases;
    if (!names || names.length === 0) continue;
    if (map[canonical] !== undefined) continue;
    for (const name of names) {
      const match = vendors.find((vendor) =>
        vendor.name.toLowerCase().includes(name.toLowerCase()),
      );
      if (match) {
        map[canonical] = match.id;
        break;
      }
    }
  }

  return map;
}

function toTargetModel(
  desiredModel: DesiredModelSpec,
  vendorNameToId: Record<string, number>,
): Omit<ModelMeta, "id"> {
  const vendorId = desiredModel.vendor
    ? vendorNameToId[desiredModel.vendor.toLowerCase()]
    : undefined;

  return {
    model_name: desiredModel.model_name,
    vendor_id: vendorId,
    endpoints: desiredModel.endpoints,
    status: 1,
    sync_official: 1,
  };
}

function buildManagedOptionValues(
  desired: DesiredState,
  snapshot: TargetSnapshot,
): Record<string, string> {
  const managedProviders = desired.managedProviders;

  const unmanagedChannels = snapshot.channels.filter(
    (channel) => !channel.tag || !managedProviders.has(channel.tag),
  );

  const unmanagedGroups = new Set(unmanagedChannels.map((channel) => channel.group));

  const protectedModels = new Set<string>();
  for (const channel of unmanagedChannels) {
    for (const model of channel.models.split(",").map((item) => item.trim())) {
      if (model) protectedModels.add(model);
    }
  }

  const existingGroupRatio = parseJsonObject<Record<string, number>>(
    snapshot.options.GroupRatio,
    {},
  );
  const existingUserGroups = parseJsonObject<Record<string, string>>(
    snapshot.options.UserUsableGroups,
    {},
  );
  const existingAutoGroups = parseJsonObject<string[]>(
    snapshot.options.AutoGroups,
    [],
  );
  const existingModelRatio = parseJsonObject<Record<string, number>>(
    snapshot.options.ModelRatio,
    {},
  );
  const existingCompletionRatio = parseJsonObject<Record<string, number>>(
    snapshot.options.CompletionRatio,
    {},
  );

  const mergedGroupRatio: Record<string, number> = {};
  for (const [group, ratio] of Object.entries(existingGroupRatio)) {
    if (unmanagedGroups.has(group)) mergedGroupRatio[group] = ratio;
  }
  Object.assign(mergedGroupRatio, desired.options.groupRatio);

  const mergedUserGroups: Record<string, string> = {
    auto: DEFAULT_AUTO_LABEL,
  };
  for (const [group, label] of Object.entries(existingUserGroups)) {
    if (group === "auto") continue;
    if (unmanagedGroups.has(group)) mergedUserGroups[group] = label;
  }
  Object.assign(mergedUserGroups, desired.options.userUsableGroups);

  const mergedAutoGroups = [
    ...new Set([
      ...existingAutoGroups.filter((group) => unmanagedGroups.has(group)),
      ...desired.options.autoGroups,
    ]),
  ].sort((a, b) => (mergedGroupRatio[a] ?? 1) - (mergedGroupRatio[b] ?? 1));

  const mergedModelRatio: Record<string, number> = {};
  for (const [model, ratio] of Object.entries(existingModelRatio)) {
    if (protectedModels.has(model)) mergedModelRatio[model] = ratio;
  }
  Object.assign(mergedModelRatio, desired.options.modelRatio);

  const mergedCompletionRatio: Record<string, number> = {};
  for (const [model, ratio] of Object.entries(existingCompletionRatio)) {
    if (protectedModels.has(model)) mergedCompletionRatio[model] = ratio;
  }
  Object.assign(mergedCompletionRatio, desired.options.completionRatio);

  return {
    GroupRatio: JSON.stringify(stableObject(mergedGroupRatio)),
    UserUsableGroups: JSON.stringify(stableObject(mergedUserGroups)),
    AutoGroups: JSON.stringify(mergedAutoGroups),
    DefaultUseAutoGroup: desired.options.defaultUseAutoGroup ? "true" : "false",
    ModelRatio: JSON.stringify(stableObject(mergedModelRatio)),
    CompletionRatio: JSON.stringify(stableObject(mergedCompletionRatio)),
    "global.chat_completions_to_responses_policy": JSON.stringify(desired.policy),
  };
}

export function buildSyncDiff(
  config: RuntimeConfig,
  desired: DesiredState,
  snapshot: TargetSnapshot,
): SyncDiff {
  const managedProviders = config.onlyProviders ?? desired.managedProviders;

  const channelOps: DiffOperation<Channel>[] = [];
  const existingByName = new Map(snapshot.channels.map((channel) => [channel.name, channel]));
  const desiredByName = new Map(desired.channels.map((channel) => [channel.name, channel]));

  for (const desiredChannel of desired.channels) {
    const existing = existingByName.get(desiredChannel.name);
    if (!existing) {
      channelOps.push({
        type: "create",
        key: desiredChannel.name,
        value: desiredChannel,
      });
      continue;
    }

    const normalizedDesired = {
      ...desiredChannel,
      id: existing.id,
    };

    if (channelChanged(existing, normalizedDesired)) {
      channelOps.push({
        type: "update",
        key: desiredChannel.name,
        existing,
        value: normalizedDesired,
      });
    }
  }

  for (const existing of snapshot.channels) {
    if (!existing.tag || !managedProviders.has(existing.tag)) continue;
    if (desiredByName.has(existing.name)) continue;

    channelOps.push({
      type: "delete",
      key: existing.name,
      existing,
    });
  }

  const vendorNameToId = mapVendorIds(snapshot.vendors);
  const modelOps: DiffOperation<ModelMeta>[] = [];
  const existingModelsByName = new Map(
    snapshot.models.map((model) => [model.model_name, model]),
  );

  const protectedModels = new Set<string>();
  for (const channel of snapshot.channels) {
    if (channel.tag && managedProviders.has(channel.tag)) continue;
    for (const model of channel.models.split(",").map((item) => item.trim())) {
      if (model) protectedModels.add(model);
    }
  }

  for (const [modelName, desiredModel] of desired.models.entries()) {
    const existing = existingModelsByName.get(modelName);
    const targetModel = toTargetModel(desiredModel, vendorNameToId);

    if (!existing) {
      modelOps.push({
        type: "create",
        key: modelName,
        value: targetModel,
      });
      continue;
    }

    const needsUpdate =
      existing.vendor_id !== targetModel.vendor_id ||
      existing.endpoints !== targetModel.endpoints ||
      existing.sync_official !== 1 ||
      existing.status !== 1;

    if (needsUpdate) {
      modelOps.push({
        type: "update",
        key: modelName,
        existing,
        value: {
          ...targetModel,
          id: existing.id,
        },
      });
    }
  }

  for (const existing of snapshot.models) {
    const modelName = existing.model_name;
    if (desired.models.has(modelName)) continue;
    if (protectedModels.has(modelName)) continue;

    const isMappingSource = desired.mappingSources.has(modelName);
    if (!isMappingSource && existing.sync_official !== 1) continue;
    if (!existing.id) continue;

    modelOps.push({
      type: "delete",
      key: modelName,
      existing,
    });
  }

  const desiredOptionValues = buildManagedOptionValues(desired, snapshot);
  const optionOps: DiffOperation<string>[] = [];
  for (const [key, value] of Object.entries(desiredOptionValues)) {
    const existing = snapshot.options[key];
    if (existing === undefined) {
      optionOps.push({
        type: "create",
        key,
        value,
      });
      continue;
    }

    if (existing !== value) {
      optionOps.push({
        type: "update",
        key,
        existing,
        value,
      });
    }
  }

  return {
    channels: channelOps,
    models: modelOps,
    options: optionOps,
    cleanupOrphans: true,
  };
}
