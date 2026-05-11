import {
  matchesAnyPattern,
  parseModelList,
} from "@core/catalog/constants/patterns";
import { forEachVendor } from "@core/catalog/constants/vendor-matchers";
import type { RuntimeConfig } from "@core/config";
import type {
  Channel,
  DesiredState,
  DiffOperation,
  ModelMeta,
  SyncDiff,
  TargetSnapshot,
  Vendor,
} from "@core/types";
import { t } from "@server/i18n";
import { deepEqual } from "fast-equals";
import stringify from "safe-stable-stringify";

function collectModelsFromChannels(channels: Channel[]): Set<string> {
  const models = new Set<string>();
  for (const ch of channels) {
    for (const m of parseModelList(ch.models)) models.add(m);
  }
  return models;
}

function stableJson(input: Record<string, unknown>): string {
  return stringify(input) ?? "{}";
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

/** Sync capabilities; preserve manual fields (proxy, system_prompt, ...). */
function mergeSettingCapabilities(
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
    workflow_templates: normalizeWorkflowTemplates(channel.workflow_templates),
    // comfyui overrides this; undefined either side = no opinion.
    auto_ban: channel.auto_ban,
  };
}

/** Stable stringify so key-order / whitespace changes don't trigger spurious updates. */
function normalizeWorkflowTemplates(
  workflowTemplates?: string,
): string | undefined {
  if (!workflowTemplates) return undefined;
  try {
    const parsed = JSON.parse(workflowTemplates);
    return stringify(parsed) ?? undefined;
  } catch {
    return workflowTemplates; // invalid JSON: leave as-is so the diff still flags it
  }
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

  // `in` checks (not truthiness) so a legit 0 ratio from free providers still propagates.
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

  // Guard: unmanaged channel models + managed-but-no-pricing-this-sync.
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

  // Collapses 8× near-identical mergeProtected(parse(...), guard, desired) calls.
  const mergeOption = <T>(
    key: string,
    guard: Set<string>,
    desired: Record<string, T>,
  ): Record<string, T> =>
    mergeProtected(parse<Record<string, T>>(key, {}), guard, desired);

  // --only: guard keys from non-included providers; managed providers stay updatable.
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
  // Mirror managedGroups for models: must NOT guard, else --only can't update its own pricing.
  const managedModels = new Set<string>();
  for (const channel of snapshot.channels) {
    if (channel.tag && desired.managedProviders.has(channel.tag)) {
      for (const m of parseModelList(channel.models)) managedModels.add(m);
    }
  }
  for (const channel of desired.channels) {
    for (const m of parseModelList(channel.models)) managedModels.add(m);
  }

  const modelGuard = isPartialSync
    ? new Set(
        [
          ...modelRatioGuard,
          ...Object.keys(parse<Record<string, unknown>>("ModelRatio", {})),
          ...Object.keys(parse<Record<string, unknown>>("ModelPrice", {})),
          ...Object.keys(parse<Record<string, unknown>>("CompletionRatio", {})),
          ...Object.keys(parse<Record<string, unknown>>("ImageRatio", {})),
          ...Object.keys(parse<Record<string, unknown>>("CacheRatio", {})),
          ...Object.keys(parse<Record<string, unknown>>("CreateCacheRatio", {})),
          ...Object.keys(parse<Record<string, unknown>>("ModelQuotaType", {})),
          ...Object.keys(parse<Record<string, unknown>>("ModelGridPricing", {})),
        ].filter((m) => !managedModels.has(m)),
      )
    : modelRatioGuard;

  const mergedGroupRatio = mergeOption(
    "GroupRatio",
    groupGuard,
    desired.options.groupRatio,
  );
  const mergedUserGroups = mergeProtected(
    parse<Record<string, string>>("UserUsableGroups", {}),
    groupGuard,
    { auto: t("CORE.GROUPS.AUTO_LABEL"), ...desired.options.userUsableGroups },
  );
  const mergedAutoGroups = [
    ...new Set([
      ...parse<string[]>("AutoGroups", []).filter((g) => groupGuard.has(g)),
      ...desired.options.autoGroups,
    ]),
  ].sort((a, b) => (mergedGroupRatio[a] ?? 1) - (mergedGroupRatio[b] ?? 1));

  const modelOptions: [string, Record<string, unknown>][] = [
    ["ModelRatio", desired.options.modelRatio],
    ["CompletionRatio", desired.options.completionRatio],
    ["ModelPrice", desired.options.modelPrice],
    ["ImageRatio", desired.options.imageRatio],
    ["CacheRatio", desired.options.cacheRatio],
    ["CreateCacheRatio", desired.options.createCacheRatio],
    ["ModelQuotaType", desired.options.modelQuotaType],
    ["ModelGridPricing", desired.options.modelGridPricing],
  ];

  // Escaped + anchored exact-match patterns for chat/completions → /v1/responses policy.
  const modelPatterns = desired.options.responsesApiModels.map(
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
    ...Object.fromEntries(
      modelOptions.map(([key, value]) => [
        key,
        stableJson(mergeOption(key, modelGuard, value)),
      ]),
    ),
    "global.chat_completions_to_responses_policy": responsesPolicy,
  };
}

function buildVendorIdMap(vendors: Vendor[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const vendor of vendors) {
    map[vendor.name.toLowerCase()] = vendor.id;
  }

  forEachVendor((canonical, matcher) => {
    const names = matcher.nameAliases;
    if (!names || names.length === 0) return;
    if (map[canonical] !== undefined) return;
    for (const name of names) {
      const match = vendors.find((v) =>
        v.name.toLowerCase().includes(name.toLowerCase()),
      );
      if (match) {
        map[canonical] = match.id;
        return;
      }
    }
  });

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
      !deepEqual(
        normalizeChannel(existing),
        normalizeChannel(normalizedDesired),
      )
    ) {
      channelOps.push({
        type: "update",
        key: desiredChannel.name,
        existing,
        value: normalizedDesired,
      });
    }
  }

  // --models filter: only delete channels whose current models intersect the filter.
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

  // Older new-api lacks the metadata column; detect by any row defining the field.
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
    // --models filter applies to delete-scope too.
    if (
      modelFilter &&
      modelFilter.length > 0 &&
      !matchesAnyPattern(modelName, modelFilter)
    )
      continue;

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
