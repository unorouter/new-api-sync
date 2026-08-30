import { inferModelType } from "@core/catalog/constants/inference";
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
  ModelType,
  SyncDiff,
  TargetSnapshot,
  Vendor,
} from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
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

function extractPassThrough(setting?: string): boolean | undefined {
  if (!setting) return undefined;
  try {
    const v = JSON.parse(setting)?.pass_through_body_enabled;
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

function extractPositiveNumber(
  setting: string | undefined,
  key: string,
): number | undefined {
  if (!setting) return undefined;
  try {
    const v = JSON.parse(setting)?.[key];
    return typeof v === "number" && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function extractSystemPrompt(
  setting?: string,
): { prompt: string; override: boolean } | undefined {
  if (!setting) return undefined;
  try {
    const s = JSON.parse(setting);
    if (typeof s?.system_prompt !== "string" || !s.system_prompt)
      return undefined;
    return {
      prompt: s.system_prompt,
      override: s.system_prompt_override === true,
    };
  } catch {
    return undefined;
  }
}

function mergeSettingCapabilities(
  existingSetting?: string,
  desiredSetting?: string,
): string | undefined {
  const desiredCaps = extractCapabilities(desiredSetting);
  const desiredPassThrough = extractPassThrough(desiredSetting);
  const desiredSysPrompt = extractSystemPrompt(desiredSetting);
  const desiredAutoTestInterval = extractPositiveNumber(
    desiredSetting,
    "auto_test_interval_minutes",
  );
  const desiredAutoTestIntervalMax = extractPositiveNumber(
    desiredSetting,
    "auto_test_interval_max_minutes",
  );
  if (
    !desiredCaps &&
    desiredPassThrough === undefined &&
    !desiredSysPrompt &&
    desiredAutoTestInterval === undefined &&
    desiredAutoTestIntervalMax === undefined
  )
    return undefined;
  let existing: Record<string, unknown> = {};
  if (existingSetting) {
    try {
      existing = JSON.parse(existingSetting);
    } catch (err) {
      // Unparseable: keep verbatim instead of dropping its other fields.
      consola.warn(
        `Channel setting unparseable, preserving as-is: ${err instanceof Error ? err.message : String(err)}`,
      );
      return existingSetting;
    }
  }
  // Merge, never replace: `responses` is set out-of-band (the gateway converts
  // Responses -> Chat Completions unless a channel is marked as serving it
  // natively, and that conversion drops SSE, so Codex sees a dead stream).
  // A wholesale overwrite wiped those marks on every sync, 43 down to 11.
  if (desiredCaps) {
    const liveCaps = extractCapabilities(existingSetting) ?? {};
    existing.capabilities = { ...liveCaps, ...desiredCaps };
  }
  if (desiredPassThrough !== undefined)
    existing.pass_through_body_enabled = desiredPassThrough;
  if (desiredSysPrompt) {
    existing.system_prompt = desiredSysPrompt.prompt;
    existing.system_prompt_override = desiredSysPrompt.override;
  }
  // Clear the obsolete thinking_to_content workaround (see emit.ts) so a resync
  // strips it from channels that still carry it.
  delete existing.thinking_to_content;
  if (desiredAutoTestInterval !== undefined)
    existing.auto_test_interval_minutes = desiredAutoTestInterval;
  if (desiredAutoTestIntervalMax !== undefined)
    existing.auto_test_interval_max_minutes = desiredAutoTestIntervalMax;
  return JSON.stringify(existing);
}

// Diff key: capabilities + passthrough + system_prompt are the setting fields the sync owns.
function normalizeCapabilities(setting?: string): string | undefined {
  const caps = extractCapabilities(setting);
  const passThrough = extractPassThrough(setting);
  const sysPrompt = extractSystemPrompt(setting);
  const autoTestInterval = extractPositiveNumber(
    setting,
    "auto_test_interval_minutes",
  );
  const autoTestIntervalMax = extractPositiveNumber(
    setting,
    "auto_test_interval_max_minutes",
  );
  if (
    !caps &&
    passThrough === undefined &&
    !sysPrompt &&
    autoTestInterval === undefined &&
    autoTestIntervalMax === undefined
  )
    return undefined;
  return JSON.stringify({
    ...(caps ? { capabilities: caps } : {}),
    ...(passThrough !== undefined
      ? { pass_through_body_enabled: passThrough }
      : {}),
    ...(sysPrompt
      ? {
          system_prompt: sysPrompt.prompt,
          system_prompt_override: sysPrompt.override,
        }
      : {}),
    ...(autoTestInterval !== undefined
      ? { auto_test_interval_minutes: autoTestInterval }
      : {}),
    ...(autoTestIntervalMax !== undefined
      ? { auto_test_interval_max_minutes: autoTestIntervalMax }
      : {}),
  });
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
    header_override: normalizeParamOverride(c.header_override),
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
const PARTIAL_MODEL_OPTION_KEYS = ["ModelRatio","ModelPrice","CompletionRatio","ImageRatio","CacheRatio","CreateCacheRatio","AudioRatio","AudioCompletionRatio","ModelQuotaType","ModelGridPricing","billing_setting.billing_mode","billing_setting.billing_expr","ModelRequestRateLimitModels"] as const;

function buildManagedOptionValues(
  desired: DesiredState,
  snapshot: TargetSnapshot,
  isPartialSync: boolean,
  modelFilter?: string[],
  modelTypeFilter?: ModelType[],
): Record<string, string> {
  const opts = desired.options;
  // In a partial (--models / --type) sync, a model on a managed channel is only
  // "in scope" if it matches the filter. Managed-channel models outside the
  // filter must keep their existing options, else their ratios get wiped.
  const typeSet = modelTypeFilter?.length
    ? new Set(modelTypeFilter)
    : undefined;
  const inFilterScope = (m: string) =>
    (!modelFilter?.length && !typeSet) ||
    (!!modelFilter?.length && matchesAnyPattern(m, modelFilter)) ||
    (typeSet !== undefined && typeSet.has(inferModelType(m)));
  const isManaged = (ch: Channel) =>
    ch.tag && desired.managedProviders.has(ch.tag);
  const unmanagedChannels = snapshot.channels.filter((ch) => !isManaged(ch));
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

  const partialKeys = (k: string) =>
    Object.keys(parse<Record<string, unknown>>(k, {}));

  const managedModels = new Set<string>();
  for (const ch of snapshot.channels)
    if (isManaged(ch))
      for (const m of parseModelList(ch.models))
        if (inFilterScope(m)) managedModels.add(m);
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

  // Group options are ADDITIVE here: desired entries add/update, existing ones
  // are never removed by the merge. A run only computes tiers for models that
  // passed ITS probe, so removal-by-omission deleted the usable/auto/ratio
  // entries of every live channel whose model merely throttled during that
  // run's probe (free tiers do constantly) - recurring "live channel, invisible
  // model" incidents. The ONLY removal authority is pruneDeadOptionGroups in
  // apply.ts, which sees the full post-apply channel list.
  const mergedGroupRatio = {
    ...parse<Record<string, number>>("GroupRatio", {}),
    ...opts.groupRatio,
  };
  const mergedUserGroups = {
    ...parse<Record<string, string>>("UserUsableGroups", {}),
    auto: t("CORE.GROUPS.AUTO_LABEL"),
    ...opts.userUsableGroups,
  };
  const mergedAutoGroups = [
    ...new Set([...parse<string[]>("AutoGroups", []), ...opts.autoGroups]),
  ].sort((a, b) => (mergedGroupRatio[a] ?? 1) - (mergedGroupRatio[b] ?? 1));

  // prettier-ignore
  const modelOptions: [string, Record<string, unknown>][] = [["ModelRatio", opts.modelRatio],["CompletionRatio", opts.completionRatio],["ModelPrice", opts.modelPrice],["ImageRatio", opts.imageRatio],["CacheRatio", opts.cacheRatio],["CreateCacheRatio", opts.createCacheRatio],["AudioRatio", opts.audioRatio],["AudioCompletionRatio", opts.audioCompletionRatio],["ModelQuotaType", opts.modelQuotaType],["ModelGridPricing", opts.modelGridPricing],["billing_setting.billing_mode", opts.billingMode],["billing_setting.billing_expr", opts.billingExpr],["ModelRequestRateLimitModels", opts.modelRateLimits]];

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
    // Status is owned by new-api after creation (its auto-test enables/disables
    // on probe result). Preserve the live status on update so a sync never
    // clobbers an auto-enabled rate-limited channel back to disabled.
    normalizedDesired.status = existing.status;
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
  const typeFilter = config.modelTypeFilter;
  const hasModelFilter = (modelFilter?.length ?? 0) > 0;
  const hasTypeFilter = (typeFilter?.length ?? 0) > 0;
  const isPartialSync =
    config.onlyProviders !== undefined || hasModelFilter || hasTypeFilter;
  const typeSet = hasTypeFilter ? new Set(typeFilter) : undefined;
  const inScope = (channel: Channel): boolean => {
    if (!hasModelFilter && !typeSet) return true;
    return parseModelList(channel.models).some(
      (m) =>
        (hasModelFilter && matchesAnyPattern(m, modelFilter!)) ||
        (typeSet !== undefined && typeSet.has(inferModelType(m))),
    );
  };

  // A channel carries the tag of the provider that owns it, and managedProviders
  // is already narrowed to --only, so a provider-scoped run can delete its OWN
  // stale channels without reaching another provider's. A --models/--type filter
  // cannot: it conflates "this lane is dead" with "its models were filtered out
  // of this run", so those runs still delete nothing.
  const skipChannelDeletes = hasModelFilter || hasTypeFilter;
  if (!skipChannelDeletes) {
    for (const existing of snapshot.channels) {
      if (!existing.tag || !managedProviders.has(existing.tag)) continue;
      if (desiredByName.has(existing.name) || !inScope(existing)) continue;
      channelOps.push({ type: "delete", key: existing.name, existing });
    }
  }

  const vendorNameToId = buildVendorIdMap(snapshot.vendors);
  const modelOps: DiffOperation<ModelMeta>[] = [];
  // Metadata support is inferred from the snapshot carrying a metadata field.
  // An EMPTY snapshot (e.g. the first sync after `reset`) carries none, which
  // must NOT read as "unsupported" or the whole run ships without metadata;
  // assume supported when there are no models to disprove it. Only a non-empty
  // snapshot whose models all lack the field indicates a genuinely old server.
  const serverSupportsMetadata =
    snapshot.models.length === 0 ||
    snapshot.models.some((m) => m.metadata !== undefined);

  const existingModelsByName = new Map<string, ModelMeta>();
  for (const model of snapshot.models) {
    const prev = existingModelsByName.get(model.model_name);
    if (!prev) {
      existingModelsByName.set(model.model_name, model);
      continue;
    }
    // Keep the better row: a resolved vendor_id beats 0 (stale-snapshot creates
    // land 0), then higher id wins. Score = [hasVendor, id]; bigger keeps.
    const score = (m: ModelMeta): [number, number] => [
      (m.vendor_id ?? 0) !== 0 ? 1 : 0,
      m.id ?? 0,
    ];
    const [ps, ms] = [score(prev), score(model)];
    const [keep, discard] =
      ms[0] > ps[0] || (ms[0] === ps[0] && ms[1] > ps[1])
        ? [model, prev]
        : [prev, model];
    existingModelsByName.set(model.model_name, keep);
    // A duplicate of a model in the desired set is always safe to delete: this
    // sync (re)creates/updates that name anyway. Out-of-scope models are absent
    // from desired.models, so a partial sync still leaves them untouched. Full
    // sync deletes every dup (same rule as orphan cleanup).
    if (discard.id && (!isPartialSync || desired.models.has(model.model_name)))
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

  // A provider-scoped partial sync (--only) must never delete models: its desired
  // set only covers the targeted providers, so every other provider's model would
  // look orphaned and get wrongly deleted. Model deletion is left to full syncs and
  // --models filter syncs (which scope deletes to the matched names below).
  const skipModelDeletes = config.onlyProviders !== undefined;
  if (!skipModelDeletes)
    for (const existing of snapshot.models) {
      const modelName = existing.model_name;
      if (desired.models.has(modelName) || protectedModels.has(modelName))
        continue;
      // Scope deletes to the active filter(s); out-of-scope models stay untouched.
      if (hasModelFilter && !matchesAnyPattern(modelName, modelFilter!))
        continue;
      if (typeSet !== undefined && !typeSet.has(inferModelType(modelName)))
        continue;
      if (
        !desired.mappingSources.has(modelName) &&
        existing.sync_official !== 1
      )
        continue;
      if (!existing.id) continue;
      modelOps.push({ type: "delete", key: modelName, existing });
    }

  const desiredOptionValues = buildManagedOptionValues(
    desired,
    snapshot,
    isPartialSync,
    modelFilter,
    typeFilter,
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
  };
}
