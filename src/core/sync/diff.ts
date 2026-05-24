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
  for (const ch of channels)
    for (const m of parseModelList(ch.models)) models.add(m);
  return models;
}

function extractCapabilities(
  setting?: string,
): Record<string, unknown> | undefined {
  if (!setting) return undefined;
  try {
    return JSON.parse(setting)?.capabilities ?? undefined;
  } catch {
    return undefined;
  }
}

function mergeSettingCapabilities(
  existingSetting?: string,
  desiredSetting?: string,
): string | undefined {
  const desiredCaps = extractCapabilities(desiredSetting);
  if (!desiredCaps) return undefined;
  let existing: Record<string, unknown> = {};
  if (existingSetting) {
    try {
      existing = JSON.parse(existingSetting);
    } catch {}
  }
  existing.capabilities = desiredCaps;
  return JSON.stringify(existing);
}

function normalizeCapabilities(setting?: string): string | undefined {
  const caps = extractCapabilities(setting);
  return caps ? JSON.stringify(caps) : undefined;
}

function normalizeWorkflowTemplates(wf?: string): string | undefined {
  if (!wf) return undefined;
  try {
    return stringify(JSON.parse(wf)) ?? undefined;
  } catch {
    return wf;
  }
}

function normalizeChannel(c: Channel): Omit<Channel, "id"> {
  return {
    name: c.name,
    type: c.type,
    key: c.key,
    base_url: c.base_url.replace(/\/$/, ""),
    models: c.models,
    group: c.group,
    priority: c.priority,
    weight: c.weight,
    status: c.status,
    tag: c.tag,
    remark: c.remark,
    model_mapping:
      c.model_mapping && c.model_mapping !== "{}" ? c.model_mapping : undefined,
    setting: normalizeCapabilities(c.setting),
    workflow_templates: normalizeWorkflowTemplates(c.workflow_templates),
    auto_ban: c.auto_ban,
    param_override: normalizeParamOverride(c.param_override),
  };
}

function normalizeParamOverride(po?: string): string | undefined {
  if (!po) return undefined;
  try {
    return stringify(JSON.parse(po)) ?? undefined;
  } catch {
    return po;
  }
}

function mergeProtected<T>(
  existing: Record<string, T>,
  guard: Set<string>,
  desired: Record<string, T>,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const [k, v] of Object.entries(existing))
    if (guard.has(k)) merged[k] = v;
  for (const [k, v] of Object.entries(desired))
    if (!(k in merged)) merged[k] = v;
  return merged;
}

// prettier-ignore
const PARTIAL_MODEL_OPTION_KEYS = ["ModelRatio","ModelPrice","CompletionRatio","ImageRatio","CacheRatio","CreateCacheRatio","AudioRatio","AudioCompletionRatio","ModelQuotaType","ModelGridPricing","billing_setting.billing_mode","billing_setting.billing_expr"] as const;

function buildManagedOptionValues(
  desired: DesiredState,
  snapshot: TargetSnapshot,
  isPartialSync: boolean,
): Record<string, string> {
  const opts = desired.options;
  const isManaged = (ch: Channel) =>
    ch.tag && desired.managedProviders.has(ch.tag);
  const unmanagedChannels = snapshot.channels.filter((ch) => !isManaged(ch));
  const unmanagedGroups = new Set(unmanagedChannels.map((ch) => ch.group));
  const protectedModels = collectModelsFromChannels(unmanagedChannels);

  const desiredModelsWithoutRatio = new Set<string>();
  for (const channel of desired.channels)
    for (const model of parseModelList(channel.models))
      if (!(model in opts.modelRatio) && !(model in opts.modelPrice))
        desiredModelsWithoutRatio.add(model);
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
  const mergeOption = <T>(
    key: string,
    guard: Set<string>,
    d: Record<string, T>,
  ) => mergeProtected(parse<Record<string, T>>(key, {}), guard, d);

  const managedGroups = new Set(
    snapshot.channels.filter(isManaged).map((ch) => ch.group),
  );
  const partialKeys = (k: string) =>
    Object.keys(parse<Record<string, unknown>>(k, {}));
  const groupGuard = isPartialSync
    ? new Set([
        ...unmanagedGroups,
        ...partialKeys("GroupRatio").filter((g) => !managedGroups.has(g)),
      ])
    : unmanagedGroups;

  const managedModels = new Set<string>();
  for (const ch of snapshot.channels)
    if (isManaged(ch))
      for (const m of parseModelList(ch.models)) managedModels.add(m);
  for (const ch of desired.channels)
    for (const m of parseModelList(ch.models)) managedModels.add(m);

  const modelGuard = isPartialSync
    ? new Set(
        [
          ...modelRatioGuard,
          ...PARTIAL_MODEL_OPTION_KEYS.flatMap(partialKeys),
        ].filter((m) => !managedModels.has(m)),
      )
    : modelRatioGuard;

  const mergedGroupRatio = mergeOption(
    "GroupRatio",
    groupGuard,
    opts.groupRatio,
  );
  const mergedUserGroups = mergeProtected(
    parse<Record<string, string>>("UserUsableGroups", {}),
    groupGuard,
    { auto: t("CORE.GROUPS.AUTO_LABEL"), ...opts.userUsableGroups },
  );
  const mergedAutoGroups = [
    ...new Set([
      ...parse<string[]>("AutoGroups", []).filter((g) => groupGuard.has(g)),
      ...opts.autoGroups,
    ]),
  ].sort((a, b) => (mergedGroupRatio[a] ?? 1) - (mergedGroupRatio[b] ?? 1));

  // prettier-ignore
  const modelOptions: [string, Record<string, unknown>][] = [["ModelRatio", opts.modelRatio],["CompletionRatio", opts.completionRatio],["ModelPrice", opts.modelPrice],["ImageRatio", opts.imageRatio],["CacheRatio", opts.cacheRatio],["CreateCacheRatio", opts.createCacheRatio],["AudioRatio", opts.audioRatio],["AudioCompletionRatio", opts.audioCompletionRatio],["ModelQuotaType", opts.modelQuotaType],["ModelGridPricing", opts.modelGridPricing],["billing_setting.billing_mode", opts.billingMode],["billing_setting.billing_expr", opts.billingExpr]];

  const modelPatterns = opts.responsesApiModels.map(
    (m) => `^${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  );
  const sj = (x: Record<string, unknown>) => stringify(x) ?? "{}";
  return {
    GroupRatio: sj(mergedGroupRatio),
    UserUsableGroups: sj(mergedUserGroups),
    AutoGroups: JSON.stringify(mergedAutoGroups),
    DefaultUseAutoGroup: opts.defaultUseAutoGroup ? "true" : "false",
    ...Object.fromEntries(
      modelOptions.map(([k, v]) => [k, sj(mergeOption(k, modelGuard, v))]),
    ),
    "global.chat_completions_to_responses_policy": JSON.stringify({
      enabled: modelPatterns.length > 0,
      all_channels: false,
      channel_types: [1],
      model_patterns: modelPatterns,
    }),
  };
}

function buildVendorIdMap(vendors: Vendor[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const vendor of vendors) map[vendor.name.toLowerCase()] = vendor.id;
  forEachVendor((canonical, matcher) => {
    const names = matcher.nameAliases;
    if (!names || names.length === 0 || map[canonical] !== undefined) return;
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
  const channelOps: DiffOperation<Channel>[] = [];
  const existingByName = new Map(snapshot.channels.map((ch) => [ch.name, ch]));
  const desiredByName = new Map(desired.channels.map((ch) => [ch.name, ch]));

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
    normalizedDesired.setting = mergeSettingCapabilities(
      existing.setting,
      desiredChannel.setting,
    );
    if (
      !deepEqual(
        normalizeChannel(existing),
        normalizeChannel(normalizedDesired),
      )
    )
      channelOps.push({
        type: "update",
        key: desiredChannel.name,
        existing,
        value: normalizedDesired,
      });
  }

  const modelFilter = config.modelFilter;
  const isPartialSync =
    config.onlyProviders !== undefined ||
    (modelFilter?.length ?? 0) > 0;
  const inScope = (channel: Channel): boolean =>
    !modelFilter ||
    modelFilter.length === 0 ||
    parseModelList(channel.models).some((m) =>
      matchesAnyPattern(m, modelFilter),
    );

  if (!isPartialSync) {
    for (const existing of snapshot.channels) {
      if (!existing.tag || !managedProviders.has(existing.tag)) continue;
      if (desiredByName.has(existing.name) || !inScope(existing)) continue;
      channelOps.push({ type: "delete", key: existing.name, existing });
    }
  }

  const vendorNameToId = buildVendorIdMap(snapshot.vendors);
  const modelOps: DiffOperation<ModelMeta>[] = [];
  const serverSupportsMetadata = snapshot.models.some(
    (m) => m.metadata !== undefined,
  );

  const existingModelsByName = new Map<string, ModelMeta>();
  for (const model of snapshot.models) {
    const prev = existingModelsByName.get(model.model_name);
    if (!prev) {
      existingModelsByName.set(model.model_name, model);
      continue;
    }
    const [keep, discard] =
      (prev.id ?? 0) >= (model.id ?? 0) ? [prev, model] : [model, prev];
    existingModelsByName.set(model.model_name, keep);
    if (discard.id)
      modelOps.push({
        type: "delete",
        key: `${discard.model_name} (dup #${discard.id})`,
        existing: discard,
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
    if (serverSupportsMetadata) targetModel.metadata = desiredModel.metadata;

    if (!existing) {
      modelOps.push({ type: "create", key: modelName, value: targetModel });
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

    if (needsUpdate)
      modelOps.push({
        type: "update",
        key: modelName,
        existing,
        value: { ...targetModel, id: existing.id },
      });
  }

  for (const existing of snapshot.models) {
    const modelName = existing.model_name;
    if (desired.models.has(modelName) || protectedModels.has(modelName))
      continue;
    if (
      modelFilter &&
      modelFilter.length > 0 &&
      !matchesAnyPattern(modelName, modelFilter)
    )
      continue;
    if (!desired.mappingSources.has(modelName) && existing.sync_official !== 1)
      continue;
    if (!existing.id) continue;
    modelOps.push({ type: "delete", key: modelName, existing });
  }

  const desiredOptionValues = buildManagedOptionValues(
    desired,
    snapshot,
    isPartialSync,
  );
  const optionOps: DiffOperation<string>[] = [];
  for (const [key, value] of Object.entries(desiredOptionValues)) {
    const existing = snapshot.options[key];
    if (existing === undefined) optionOps.push({ type: "create", key, value });
    else if (existing !== value)
      optionOps.push({ type: "update", key, existing, value });
  }

  return {
    channels: channelOps,
    models: modelOps,
    options: optionOps,
    cleanupOrphans: !isPartialSync,
  };
}
