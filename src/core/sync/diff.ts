import type { RuntimeConfig } from "@core/config";
import {
  matchesAnyPattern,
  parseModelList,
  VENDOR_MATCHERS,
} from "@core/models/constants";
import type {
  Channel,
  DesiredState,
  DiffOperation,
  ModelMeta,
  SyncDiff,
  TargetSnapshot,
  Vendor,
} from "@core/types";

const DEFAULT_AUTO_LABEL = "Auto (Smart Routing with Failover)";

function collectModelsFromChannels(channels: Channel[]): Set<string> {
  const models = new Set<string>();
  for (const ch of channels) {
    for (const m of parseModelList(ch.models)) models.add(m);
  }
  return models;
}

function stableJson(input: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/** Extract only the capabilities portion of a setting JSON for comparison. */
function extractCapabilities(
  setting?: string,
): Record<string, unknown> | undefined {
  if (!setting) return undefined;
  try {
    const parsed = JSON.parse(setting);
    return parsed?.capabilities ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge desired capabilities into an existing setting JSON string,
 * preserving any manually configured fields (proxy, system_prompt, etc.).
 */
export function mergeSettingCapabilities(
  existingSetting: string | undefined,
  desiredSetting: string | undefined,
): string | undefined {
  const desiredCaps = extractCapabilities(desiredSetting);
  if (!desiredCaps) return undefined; // no capabilities to set

  let existing: Record<string, unknown> = {};
  if (existingSetting) {
    try {
      existing = JSON.parse(existingSetting);
    } catch {
      existing = {};
    }
  }

  existing.capabilities = desiredCaps;
  return JSON.stringify(existing);
}

function normalizeCapabilities(setting?: string): string | undefined {
  const caps = extractCapabilities(setting);
  return caps ? JSON.stringify(caps) : undefined;
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
    setting: normalizeCapabilities(channel.setting),
  };
}

/** Keep existing entries whose key is in `guard`, then add `desired` entries that aren't guarded. */
function mergeProtected<T>(
  existing: Record<string, T>,
  guard: Set<string>,
  desired: Record<string, T>,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (guard.has(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(desired)) {
    if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

function buildManagedOptionValues(
  desired: DesiredState,
  snapshot: TargetSnapshot,
  isPartialSync: boolean,
): Record<string, string> {
  const unmanagedChannels = snapshot.channels.filter(
    (channel) => !channel.tag || !desired.managedProviders.has(channel.tag),
  );

  const unmanagedGroups = new Set(
    unmanagedChannels.map((channel) => channel.group),
  );

  const protectedModels = collectModelsFromChannels(unmanagedChannels);

  // Models in desired channels that don't have explicit ratio data from the
  // sync (e.g. sub2api models — sub2api has no pricing info).  We preserve
  // their existing target values so pricing isn't wiped. Use `in` checks
  // (not truthiness) so that a legit `0` ratio from free providers still
  // counts as "the sync explicitly set it" and propagates to the DB —
  // otherwise stale non-zero ratios from prior syncs survive forever.
  const desiredModelsWithoutRatio = new Set<string>();
  for (const channel of desired.channels) {
    for (const model of parseModelList(channel.models)) {
      if (
        !(model in desired.options.modelRatio) &&
        !(model in desired.options.modelPrice)
      ) {
        desiredModelsWithoutRatio.add(model);
      }
    }
  }

  // Guard set for model-level options: protect models from unmanaged channels
  // AND models in managed channels that the sync didn't set pricing for.
  const modelRatioGuard = new Set([
    ...protectedModels,
    ...desiredModelsWithoutRatio,
  ]);

  const parse = <T>(key: string, fallback: T): T => {
    try {
      const raw = snapshot.options[key];
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };

  // During partial syncs (--only), guard existing option keys from providers
  // NOT in this run. Groups belonging to managed providers must be updatable.
  const managedGroups = new Set(
    snapshot.channels
      .filter((ch) => ch.tag && desired.managedProviders.has(ch.tag))
      .map((ch) => ch.group),
  );
  const groupGuard = isPartialSync
    ? new Set([
        ...unmanagedGroups,
        ...Object.keys(parse<Record<string, unknown>>("GroupRatio", {})).filter(
          (g) => !managedGroups.has(g),
        ),
      ])
    : unmanagedGroups;
  const modelGuard = isPartialSync
    ? new Set([
        ...modelRatioGuard,
        ...Object.keys(parse<Record<string, unknown>>("ModelRatio", {})),
        ...Object.keys(parse<Record<string, unknown>>("ModelPrice", {})),
        ...Object.keys(parse<Record<string, unknown>>("CompletionRatio", {})),
        ...Object.keys(parse<Record<string, unknown>>("ImageRatio", {})),
        ...Object.keys(parse<Record<string, unknown>>("CacheRatio", {})),
        ...Object.keys(parse<Record<string, unknown>>("CreateCacheRatio", {})),
        ...Object.keys(parse<Record<string, unknown>>("ModelQuotaType", {})),
        ...Object.keys(parse<Record<string, unknown>>("ModelGridPricing", {})),
      ])
    : modelRatioGuard;

  const mergedGroupRatio = mergeProtected(
    parse<Record<string, number>>("GroupRatio", {}),
    groupGuard,
    desired.options.groupRatio,
  );

  const mergedUserGroups = mergeProtected(
    parse<Record<string, string>>("UserUsableGroups", {}),
    groupGuard,
    { auto: DEFAULT_AUTO_LABEL, ...desired.options.userUsableGroups },
  );

  const mergedAutoGroups = [
    ...new Set([
      ...parse<string[]>("AutoGroups", []).filter((g) => groupGuard.has(g)),
      ...desired.options.autoGroups,
    ]),
  ].sort((a, b) => (mergedGroupRatio[a] ?? 1) - (mergedGroupRatio[b] ?? 1));

  const mergedModelRatio = mergeProtected(
    parse<Record<string, number>>("ModelRatio", {}),
    modelGuard,
    desired.options.modelRatio,
  );
  const mergedCompletionRatio = mergeProtected(
    parse<Record<string, number>>("CompletionRatio", {}),
    modelGuard,
    desired.options.completionRatio,
  );
  const mergedModelPrice = mergeProtected(
    parse<Record<string, number>>("ModelPrice", {}),
    modelGuard,
    desired.options.modelPrice,
  );
  const mergedImageRatio = mergeProtected(
    parse<Record<string, number>>("ImageRatio", {}),
    modelGuard,
    desired.options.imageRatio,
  );
  const mergedCacheRatio = mergeProtected(
    parse<Record<string, number>>("CacheRatio", {}),
    modelGuard,
    desired.options.cacheRatio,
  );
  const mergedCreateCacheRatio = mergeProtected(
    parse<Record<string, number>>("CreateCacheRatio", {}),
    modelGuard,
    desired.options.createCacheRatio,
  );
  const mergedModelQuotaType = mergeProtected(
    parse<Record<string, number>>("ModelQuotaType", {}),
    modelGuard,
    desired.options.modelQuotaType,
  );
  const mergedModelGridPricing = mergeProtected(
    parse<Record<string, unknown>>("ModelGridPricing", {}),
    modelGuard,
    desired.options.modelGridPricing as Record<string, unknown>,
  );

  // Build model_patterns for chat/completions → /v1/responses policy.
  // Each model name is escaped and anchored as an exact match.
  const responsesModels = desired.options.responsesApiModels;
  const modelPatterns = responsesModels.map(
    (m) => `^${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  );
  const responsesPolicy = JSON.stringify({
    enabled: modelPatterns.length > 0,
    all_channels: false,
    channel_types: [1],
    model_patterns: modelPatterns,
  });

  return {
    GroupRatio: stableJson(mergedGroupRatio),
    UserUsableGroups: stableJson(mergedUserGroups),
    AutoGroups: JSON.stringify(mergedAutoGroups),
    DefaultUseAutoGroup: desired.options.defaultUseAutoGroup ? "true" : "false",
    ModelRatio: stableJson(mergedModelRatio),
    CompletionRatio: stableJson(mergedCompletionRatio),
    ModelPrice: stableJson(mergedModelPrice),
    ImageRatio: stableJson(mergedImageRatio),
    CacheRatio: stableJson(mergedCacheRatio),
    CreateCacheRatio: stableJson(mergedCreateCacheRatio),
    ModelQuotaType: stableJson(mergedModelQuotaType),
    ModelGridPricing: stableJson(mergedModelGridPricing),
    "global.chat_completions_to_responses_policy": responsesPolicy,
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
    // Merge capabilities into existing setting to preserve manual config
    normalizedDesired.setting = mergeSettingCapabilities(
      existing.setting,
      desiredChannel.setting,
    );
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

  // When a model filter is set (--models), narrow the deletion scope so
  // channels for unrelated models stay untouched. A channel is in-scope
  // for deletion only if at least one of its current models matches the
  // filter — otherwise the user clearly didn't intend to manage it on
  // this run, and deleting it would be destructive surprise behavior.
  const modelFilter = config.modelFilter;
  const channelInModelFilterScope = (channel: Channel): boolean => {
    if (!modelFilter || modelFilter.length === 0) return true;
    const channelModels = parseModelList(channel.models);
    return channelModels.some((m) => matchesAnyPattern(m, modelFilter));
  };

  for (const existing of snapshot.channels) {
    if (!existing.tag || !managedProviders.has(existing.tag)) continue;
    if (desiredByName.has(existing.name)) continue;
    if (!channelInModelFilterScope(existing)) continue;

    channelOps.push({
      type: "delete",
      key: existing.name,
      existing,
    });
  }

  // ---- Models ----
  const vendorNameToId = buildVendorIdMap(snapshot.vendors);
  const modelOps: DiffOperation<ModelMeta>[] = [];

  // Backward-compat: older new-api versions don't have the `metadata` column.
  // If the snapshot contains at least one model with metadata defined (even an
  // empty string counts as "the field exists in the response"), we treat the
  // server as metadata-capable. Otherwise we skip pushing metadata to avoid
  // triggering futile update loops on servers that just drop the field.
  const serverSupportsMetadata = snapshot.models.some(
    (m) => m.metadata !== undefined,
  );

  // Deduplicate existing models: keep the entry with the highest ID, delete the rest.
  const existingModelsByName = new Map<string, ModelMeta>();
  const duplicateModels: ModelMeta[] = [];
  for (const model of snapshot.models) {
    const prev = existingModelsByName.get(model.model_name);
    if (!prev) {
      existingModelsByName.set(model.model_name, model);
    } else {
      // Keep the one with the higher ID (newer), schedule the other for deletion
      const [keep, discard] =
        (prev.id ?? 0) >= (model.id ?? 0) ? [prev, model] : [model, prev];
      existingModelsByName.set(model.model_name, keep);
      duplicateModels.push(discard);
    }
  }
  for (const dup of duplicateModels) {
    if (!dup.id) continue;
    modelOps.push({
      type: "delete",
      key: `${dup.model_name} (dup #${dup.id})`,
      existing: dup,
    });
  }

  const protectedModels = collectModelsFromChannels(
    snapshot.channels.filter((ch) => !ch.tag || !managedProviders.has(ch.tag)),
  );

  for (const [modelName, desiredModel] of desired.models.entries()) {
    const existing = existingModelsByName.get(modelName);
    const vendorId = desiredModel.vendor
      ? vendorNameToId[desiredModel.vendor.toLowerCase()]
      : undefined;
    const targetModel: Omit<ModelMeta, "id"> = {
      model_name: desiredModel.model_name,
      vendor_id: vendorId,
      endpoints: desiredModel.endpoints,
      description: desiredModel.description,
      tags: desiredModel.tags,
      status: 1,
      sync_official: 1,
    };
    if (serverSupportsMetadata) {
      targetModel.metadata = desiredModel.metadata;
    }

    if (!existing) {
      modelOps.push({
        type: "create",
        key: modelName,
        value: targetModel,
      });
      continue;
    }

    const metadataDiffers =
      serverSupportsMetadata &&
      (existing.metadata ?? "") !== (targetModel.metadata ?? "");

    const needsUpdate =
      existing.vendor_id !== targetModel.vendor_id ||
      existing.endpoints !== targetModel.endpoints ||
      (existing.description ?? "") !== (targetModel.description ?? "") ||
      (existing.tags ?? "") !== (targetModel.tags ?? "") ||
      metadataDiffers ||
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
    // Skip deletion of models outside the model filter scope. Same
    // reasoning as channels above — narrow the diff to the slice the
    // user actually asked about.
    if (modelFilter && modelFilter.length > 0
        && !matchesAnyPattern(modelName, modelFilter)) continue;

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
  const isPartialSync = config.onlyProviders !== undefined;
  const desiredOptionValues = buildManagedOptionValues(
    desired,
    snapshot,
    isPartialSync,
  );
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
    cleanupOrphans: config.onlyProviders === undefined,
  };
}
