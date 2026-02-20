import type { RuntimeConfig } from "@/config";
import { VENDOR_MATCHERS } from "@/lib/constants";
import type {
  Channel,
  DesiredState,
  DiffOperation,
  ModelMeta,
  SyncDiff,
  TargetSnapshot,
  Vendor,
} from "@/lib/types";

const DEFAULT_AUTO_LABEL = "Auto (Smart Routing with Failover)";

function stableJson(input: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

function normalizeChannel(channel: Channel): Omit<Channel, "id"> {
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
    model_mapping:
      channel.model_mapping && channel.model_mapping !== "{}"
        ? channel.model_mapping
        : undefined,
  };
}

/** Keep existing entries whose key is in `guard`, then overlay `desired` values on top. */
function mergeProtected<T>(
  existing: Record<string, T>,
  guard: Set<string>,
  desired: Record<string, T>,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (guard.has(key)) merged[key] = value;
  }
  return Object.assign(merged, desired);
}

function buildManagedOptionValues(
  desired: DesiredState,
  snapshot: TargetSnapshot,
): Record<string, string> {
  const unmanagedChannels = snapshot.channels.filter(
    (channel) => !channel.tag || !desired.managedProviders.has(channel.tag),
  );

  const unmanagedGroups = new Set(
    unmanagedChannels.map((channel) => channel.group),
  );

  const protectedModels = new Set<string>();
  for (const channel of unmanagedChannels) {
    for (const model of channel.models.split(",").map((item) => item.trim())) {
      if (model) protectedModels.add(model);
    }
  }

  const parse = <T>(key: string, fallback: T): T => {
    try {
      const raw = snapshot.options[key];
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };

  const mergedGroupRatio = mergeProtected(
    parse<Record<string, number>>("GroupRatio", {}),
    unmanagedGroups,
    desired.options.groupRatio,
  );

  const mergedUserGroups = mergeProtected(
    parse<Record<string, string>>("UserUsableGroups", {}),
    unmanagedGroups,
    { auto: DEFAULT_AUTO_LABEL, ...desired.options.userUsableGroups },
  );

  const mergedAutoGroups = [
    ...new Set([
      ...parse<string[]>("AutoGroups", []).filter((g) =>
        unmanagedGroups.has(g),
      ),
      ...desired.options.autoGroups,
    ]),
  ].sort((a, b) => (mergedGroupRatio[a] ?? 1) - (mergedGroupRatio[b] ?? 1));

  const mergedModelRatio = mergeProtected(
    parse<Record<string, number>>("ModelRatio", {}),
    protectedModels,
    desired.options.modelRatio,
  );
  const mergedCompletionRatio = mergeProtected(
    parse<Record<string, number>>("CompletionRatio", {}),
    protectedModels,
    desired.options.completionRatio,
  );
  const mergedModelPrice = mergeProtected(
    parse<Record<string, number>>("ModelPrice", {}),
    protectedModels,
    desired.options.modelPrice,
  );
  const mergedImageRatio = mergeProtected(
    parse<Record<string, number>>("ImageRatio", {}),
    protectedModels,
    desired.options.imageRatio,
  );

  return {
    GroupRatio: stableJson(mergedGroupRatio),
    UserUsableGroups: stableJson(mergedUserGroups),
    AutoGroups: JSON.stringify(mergedAutoGroups),
    DefaultUseAutoGroup: desired.options.defaultUseAutoGroup ? "true" : "false",
    ModelRatio: stableJson(mergedModelRatio),
    CompletionRatio: stableJson(mergedCompletionRatio),
    ModelPrice: stableJson(mergedModelPrice),
    ImageRatio: stableJson(mergedImageRatio),
  };
}

function buildVendorIdMap(vendors: Vendor[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const vendor of vendors) {
    map[vendor.name.toLowerCase()] = vendor.id;
  }

  for (const [canonical, matcher] of Object.entries(VENDOR_MATCHERS)) {
    const names = matcher.nameAliases;
    if (!names || names.length === 0) continue;
    if (map[canonical] !== undefined) continue;
    for (const name of names) {
      const match = vendors.find((v) =>
        v.name.toLowerCase().includes(name.toLowerCase()),
      );
      if (match) {
        map[canonical] = match.id;
        break;
      }
    }
  }

  return map;
}

export function buildSyncDiff(
  config: RuntimeConfig,
  desired: DesiredState,
  snapshot: TargetSnapshot,
): SyncDiff {
  const managedProviders = config.onlyProviders ?? desired.managedProviders;

  // ---- Channels ----
  const channelOps: DiffOperation<Channel>[] = [];
  const existingByName = new Map(
    snapshot.channels.map((channel) => [channel.name, channel]),
  );
  const desiredByName = new Map(
    desired.channels.map((channel) => [channel.name, channel]),
  );

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

    const normalizedDesired = { ...desiredChannel, id: existing.id };
    if (
      JSON.stringify(normalizeChannel(existing)) !==
      JSON.stringify(normalizeChannel(normalizedDesired))
    ) {
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

  // ---- Models ----
  const vendorNameToId = buildVendorIdMap(snapshot.vendors);
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
    const vendorId = desiredModel.vendor
      ? vendorNameToId[desiredModel.vendor.toLowerCase()]
      : undefined;
    const targetModel: Omit<ModelMeta, "id"> = {
      model_name: desiredModel.model_name,
      vendor_id: vendorId,
      endpoints: desiredModel.endpoints,
      status: 1,
      sync_official: 1,
    };

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

  // ---- Options ----
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
