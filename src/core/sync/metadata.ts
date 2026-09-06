// Metadata-only re-seed: every published model (served by a channel, or already
// a models-table row) gets a row with vendor + metadata, and the gateway's
// option maps are re-priced from the read-only pricing fetch, without probing.
// Metadata sources move independently of availability, so this runs every 15
// minutes while the probing full sync runs nightly.

import { applyChannelParamOverride } from "@core/pricing/param-override";
import { toBareName } from "@core/catalog/bare-name";
import {
  applyGroupRenames,
  planGroupRenames,
  printGroupRenamePlan,
} from "@core/sync/group-rename";
import {
  ENDPOINT_DEFAULT_PATHS,
  MODEL_TYPE_CANONICAL_ENDPOINT,
  normalizeEndpointType,
} from "@core/catalog/constants/endpoints";
import {
  CHANNEL_TYPES,
  getTaskModelOverride,
} from "@core/catalog/constants/channel-types";
import {
  inferModelType,
  isModerationModel,
} from "@core/catalog/constants/inference";
import {
  buildReverseMapping,
  groupsOnChannels,
  isRoutingOnlyAlias,
  matchesAnyPattern,
  modelsOnChannels,
  parseModelList,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import {
  findVendorByAlias,
  inferVendorFromModelName,
  VENDOR_MATCHERS,
} from "@core/catalog/constants/vendor-matchers";
import {
  buildMetadataMap,
  contradictsFamily,
  fetchBasellmEntries,
  fetchOpenRouterDescriptions,
} from "@core/catalog/metadata";
import type { RuntimeConfig } from "@core/config";
import {
  getMetadataFromEnabledModels,
  getPricingGridFromEnabledModels,
} from "@core/config";
import { DISABLE_THINKING_PARAM_OVERRIDE } from "@core/pricing/compute";
import {
  buildModelMetadata,
  deriveTagsFromMetadata,
  fetchAllPricingSources,
  looksTruncated,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import type { PricingSource } from "@core/pricing/sources/types";
import { updateGuestTokenIfConfigured } from "@core/sync/guest-token";
import { runProviderPipeline } from "@core/sync/pipeline";
import {
  buildAiHordeModels,
  buildRunwareModels,
  pickBetterDescription,
} from "@core/sync/pipeline/desired-models";
import {
  OptionStore,
  parseJsonObject,
  printPricingAudit,
} from "@core/sync/option-store";
import { expandRateLimitModels } from "@core/sync/pipeline/option-maps";
import { acceptPriceNotices } from "@core/vendors/a7api/pins";
import type { Channel, ModelMeta, TargetSnapshot, Vendor } from "@core/types";
import { MODEL_OPTION_FIELD, MODEL_OPTION_KEYS } from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";
import stringify from "safe-stable-stringify";

export interface MetadataSyncResult {
  total: number;
  created: number;
  patched: number;
  skipped: number;
  failed: number;
  failedModels: string[];
  renamedChannels: number;
  renamedGroups: number;
  dryRun?: boolean;
  passThroughEnabled: number;
  paramOverrideChanged: number;
  systemPromptChanged: number;
  optionErrors: string[];
}

// Resolve a model's canonical vendor to an existing vendor_id, creating the
// vendor row on the gateway if it doesn't exist yet. Caches by canonical name.
async function resolveVendorId(
  target: NewApiClient,
  vendors: Vendor[],
  cache: Map<string, number | undefined>,
  canonical: string,
): Promise<number | undefined> {
  if (cache.has(canonical)) return cache.get(canonical);
  const existing = findVendorByAlias(vendors, canonical);
  if (existing) {
    cache.set(canonical, existing.id);
    return existing.id;
  }
  const matcher = VENDOR_MATCHERS[canonical];
  const displayName =
    matcher?.displayName ??
    canonical.charAt(0).toUpperCase() + canonical.slice(1);
  const created = await target.createVendor({
    name: displayName,
    icon: matcher?.icon,
  });
  if (created) {
    vendors.push(created);
    cache.set(canonical, created.id);
    consola.info(
      t("CORE.SYNC.VENDOR_CREATED", {
        name: displayName,
        id: created.id,
        icon: matcher?.icon ?? t("CORE.SYNC.ICON_NONE"),
      }),
    );
    return created.id;
  }
  cache.set(canonical, undefined);
  return undefined;
}

// Default endpoint JSON for a freshly-created row, inferred from the model type.
// Moderation is keyed by name rather than type: a classifier is text-typed (it
// emits a category object, not an image), so the type map cannot reach it.
function inferEndpoints(name: string): string | undefined {
  if (isModerationModel(name))
    return JSON.stringify({ moderations: ENDPOINT_DEFAULT_PATHS.moderations });
  const canonicalEp = MODEL_TYPE_CANONICAL_ENDPOINT[inferModelType(name)];
  if (!canonicalEp) return undefined;
  const path = ENDPOINT_DEFAULT_PATHS[normalizeEndpointType(canonicalEp)];
  return path ? JSON.stringify({ [canonicalEp]: path }) : undefined;
}

// Tags string for a row. First tag is the capitalized model type (drives the UI
// tab), then the metadata-derived flags/context. inferModelType is name-based here
// (the create/re-seed path has no offer endpoints), which is correct for whisper/
// tts/embedding/image whose names are unambiguous.
function buildTags(
  name: string,
  sources: PricingSource[],
  reverseMapping: Map<string, string>,
  imageChannelModels: Set<string>,
): string {
  // Image-channel models (aihorde, runware) have names like tunix-pony,
  // anything-v5 or wai-illustrious that carry no image keyword, so
  // name-inference would wrongly tag them Text. Force image for those.
  const modelType = imageChannelModels.has(name)
    ? "image"
    : inferModelType(name);
  const typeTag = modelType.charAt(0).toUpperCase() + modelType.slice(1);
  const sourceMeta = resolveSourceMetadata(name, sources, reverseMapping);
  // Same fuzzy-match hazard as the metadata above: without this a checkpoint that
  // matched a text model's entry is tagged with a context window it does not have.
  const sourceTags = deriveTagsFromMetadata(
    imageChannelModels.has(name)
      ? { ...sourceMeta, contextWindow: undefined, maxInputTokens: undefined }
      : sourceMeta,
  );
  const seen = new Set<string>();
  return [typeTag, ...sourceTags]
    .filter(
      (tag) =>
        tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()),
    )
    .join(",");
}

function publishedNamesFromChannels(channels: Channel[]): Set<string> {
  return modelsOnChannels(channels, {
    enabledOnly: false,
    includeAliases: false,
  });
}

// The published name a channel SHOULD use for `published` given the current
// modelMapping: strip a trailing `:free`, remap the base, re-add `:free`. The
// `:free` suffix is the free/paid split identity and is preserved.
function correctPublishedName(
  published: string,
  modelMapping: Record<string, string>,
): string {
  const free = published.endsWith(":free");
  const base = free ? published.slice(0, -":free".length) : published;
  const mapped = modelMapping[base] ?? base;
  return free ? `${mapped}:free` : mapped;
}

// Rename any channel-published names that drifted from what the current
// modelMapping produces (e.g. a leftover `{slug}-free:free`). Rewrites the
// channel `models` CSV + `model_mapping` KEY in place; the upstream forward value
// is untouched so routing is unchanged. Pure gateway data, no probing. Mutates
// `channels` so downstream metadata reseeding sees the corrected names.
async function normalizePublishedNames(
  target: NewApiClient,
  channels: Channel[],
  config: RuntimeConfig,
): Promise<number> {
  let renamed = 0;
  for (const ch of channels) {
    const published = parseModelList(ch.models);
    let mapping: Record<string, string> = {};
    try {
      mapping = ch.model_mapping ? JSON.parse(ch.model_mapping) : {};
    } catch {
      mapping = {};
    }

    const renames: Array<[string, string]> = [];
    for (const name of published) {
      if (isRoutingOnlyAlias(name)) continue;
      const correct = correctPublishedName(name, config.modelMapping);
      if (correct !== name && !published.includes(correct))
        renames.push([name, correct]);
    }
    if (renames.length === 0) continue;

    const nextNames = published.map((n) => {
      const hit = renames.find(([from]) => from === n);
      return hit ? hit[1] : n;
    });
    const nextMapping: Record<string, string> = { ...mapping };
    for (const [from, to] of renames) {
      if (from in nextMapping) {
        nextMapping[to] = nextMapping[from]!;
        delete nextMapping[from];
      }
    }

    const ok = await target.updateChannel({
      ...ch,
      models: nextNames.join(","),
      model_mapping: JSON.stringify(nextMapping),
    });
    if (ok) {
      ch.models = nextNames.join(",");
      ch.model_mapping = JSON.stringify(nextMapping);
      renamed++;
      for (const [from, to] of renames)
        consola.info(t("CORE.METADATA.CHANNEL_RENAMED", { from, to }));
    }
  }
  return renamed;
}

// Parse, let the caller edit, write back only when the edit reports a change.
// An unparseable setting is left alone rather than clobbered.
async function patchSetting(
  target: NewApiClient,
  ch: Channel,
  edit: (setting: Record<string, unknown>) => boolean,
): Promise<boolean> {
  let setting: Record<string, unknown> = {};
  if (ch.setting) {
    try {
      setting = JSON.parse(ch.setting);
    } catch {
      return false;
    }
  }
  if (!edit(setting)) return false;
  const next = JSON.stringify(setting);
  if (!(await target.updateChannel({ ...ch, setting: next }))) return false;
  ch.setting = next;
  return true;
}

// Media channels (image/video/audio/embedding) must forward the raw client body so non-struct fields
// (image_urls, vendor extras) survive new-api's ImageRequest re-marshal, which drops unknown fields.
// Patch pass_through_body_enabled onto any media channel missing it. Gateway-only, no probing.
async function reconcilePassThrough(
  target: NewApiClient,
  channels: Channel[],
): Promise<number> {
  let changed = 0;
  for (const ch of channels) {
    // ALI (17) DashScope channels need the gateway's native-shape conversion
    // (input.messages, model rewrite); pass-through would forward the raw OpenAI
    // body and 400/404. Never enable pass-through on them.
    if (ch.type === CHANNEL_TYPES.ALI) continue;
    // Runware (62) takes an ARRAY of task objects, not an OpenAI image request. Passing the
    // raw body through skips the adaptor's conversion and the upstream answers
    // invalidPayloadFormat for every generation.
    if (ch.type === CHANNEL_TYPES.RUNWARE) continue;
    const served = parseModelList(ch.models).filter(
      (name) => !isRoutingOnlyAlias(name),
    );
    const isMedia = served.some((name) => inferModelType(name) !== "text");
    if (!isMedia) continue;
    // Gemini (24) covers BOTH task models (veo/imagen, native-shape bodies that need
    // pass-through) and chat-completions image models (gemini-*-image), which are sent as an
    // OpenAI `messages` body. Passing that through skips the gateway's messages -> contents
    // conversion and the native API rejects it with "contents is required". Only task-routed
    // Gemini channels get pass-through.
    const wantPassThrough =
      ch.type !== CHANNEL_TYPES.GEMINI ||
      served.some((name) => getTaskModelOverride(name));
    const ok = await patchSetting(target, ch, (setting) => {
      if (setting.pass_through_body_enabled === wantPassThrough) return false;
      setting.pass_through_body_enabled = wantPassThrough;
      return true;
    });
    if (!ok) continue;
    changed++;
    consola.info(
      t(
        wantPassThrough
          ? "CORE.METADATA.CHANNEL_PASSTHROUGH_ENABLED"
          : "CORE.METADATA.CHANNEL_PASSTHROUGH_DISABLED",
        { name: ch.name },
      ),
    );
  }
  return changed;
}

// disableThinking is a PER-PROVIDER opt-in: a provider's enabledModels
// metadata.disableThinking only affects THAT provider's channels. Channels are
// named `${sanitizeGroupName(provider)}-${sanitizeGroupName(model)}`, so we scope
// each provider's globs to channels whose name carries its sanitized prefix.
function buildDisableThinkingByProvider(
  config: RuntimeConfig,
): { prefix: string; globs: string[] }[] {
  const out: { prefix: string; globs: string[] }[] = [];
  for (const provider of config.providers) {
    const metaByModel = getMetadataFromEnabledModels(provider.enabledModels);
    const globs = Object.entries(metaByModel)
      .filter(([, meta]) => meta.disableThinking)
      .map(([glob]) => glob);
    if (globs.length > 0) {
      out.push({ prefix: `${sanitizeGroupName(provider.name)}-`, globs });
    }
  }
  return out;
}

async function reconcileParamOverride(
  target: NewApiClient,
  channels: Channel[],
  config: RuntimeConfig,
): Promise<number> {
  const byProvider = buildDisableThinkingByProvider(config);
  const rules = config.channelParamOverride;
  if (byProvider.length === 0 && rules.length === 0) return 0;

  let changed = 0;
  for (const ch of channels) {
    const current = ch.param_override?.trim() || undefined;

    // Only a provider that owns this channel (name prefix) may flag it, so
    // lf1's glm globs never touch io1/nvy/... channels that serve GLM fine.
    // A channel with no owner-provider wants no override, so a stale thinking
    // override on it (e.g. from an earlier unscoped run) gets cleared.
    const owner = byProvider.find((p) => ch.name.startsWith(p.prefix));
    const wantsDisable =
      owner !== undefined &&
      parseModelList(ch.models).some(
        (name) =>
          !isRoutingOnlyAlias(name) && matchesAnyPattern(name, owner.globs),
      );
    const desired = applyChannelParamOverride(
      ch.name,
      wantsDisable ? DISABLE_THINKING_PARAM_OVERRIDE : undefined,
      rules,
    );
    if (current === desired) continue;
    // Preserve an override the sync did not author (e.g. Claude 1m): only an
    // empty, thinking-only or rule-shaped value is ours to rewrite.
    if (
      current &&
      current !== DISABLE_THINKING_PARAM_OVERRIDE &&
      current !== applyChannelParamOverride(ch.name, undefined, rules)
    )
      continue;

    const ok = await target.updateChannel({
      ...ch,
      param_override: desired ?? "",
    });
    if (ok) {
      ch.param_override = desired;
      changed++;
      consola.info(
        t("CORE.METADATA.CHANNEL_PARAM_OVERRIDE_SET", {
          name: ch.name,
          action: desired ? "set" : "cleared",
        }),
      );
    }
  }
  return changed;
}

// systemPrompt injection (channel.setting.system_prompt) is otherwise written
// only when a channel is CREATED by a full sync run. Reconcile it onto EXISTING
// channels too: match each channel's published model names against the config
// globs and set/clear the prompt to match. Runs on every metadata + full sync so
// editing the prompt/scope propagates without recreating channels.
export async function reconcileSystemPrompt(
  target: NewApiClient,
  channels: Channel[],
  config: RuntimeConfig,
): Promise<number> {
  const rules = config.systemPrompt ?? [];
  if (rules.length === 0) return 0;

  let changed = 0;
  for (const ch of channels) {
    const rule = rules.find((r) =>
      parseModelList(ch.models).some(
        (name) =>
          !isRoutingOnlyAlias(name) && matchesAnyPattern(name, r.models),
      ),
    );

    const wantPrompt = rule?.prompt ?? "";
    const wantOverride = rule ? rule.override === true : false;
    const ok = await patchSetting(target, ch, (setting) => {
      const curPrompt =
        typeof setting.system_prompt === "string" ? setting.system_prompt : "";
      const curOverride = setting.system_prompt_override === true;
      if (curPrompt === wantPrompt && curOverride === wantOverride)
        return false;
      if (wantPrompt) {
        setting.system_prompt = wantPrompt;
        setting.system_prompt_override = wantOverride;
      } else {
        delete setting.system_prompt;
        delete setting.system_prompt_override;
      }
      return true;
    });
    if (!ok) continue;
    changed++;
    consola.info(
      t("CORE.METADATA.CHANNEL_SYSTEM_PROMPT_SET", {
        name: ch.name,
        action: wantPrompt ? "set" : "cleared",
      }),
    );
  }
  return changed;
}

// What a re-seed would change on an existing row, and why. Pure so the reasons
// can be logged and the churn diagnosed from the cluster log.
function planRowPatch(
  name: string,
  existing: ModelMeta,
  computed: {
    merged: Record<string, unknown> | undefined;
    vendorId: number | undefined;
    tags: string;
    description: string | undefined;
    isImageChannel: boolean;
  },
): { patch: Partial<ModelMeta>; reasons: string[] } {
  const patch: Partial<ModelMeta> = {};
  const reasons: string[] = [];
  const { merged, vendorId, tags, description } = computed;

  if (
    merged &&
    stringify(parseJsonObject(existing.metadata)) !== stringify(merged)
  ) {
    patch.metadata = JSON.stringify(merged);
    const was = parseJsonObject(existing.metadata);
    const fields = [...new Set([...Object.keys(was), ...Object.keys(merged)])]
      .filter((k) => stringify(was[k]) !== stringify(merged[k]))
      .sort();
    reasons.push(`metadata(${fields.join(" ")})`);
  }
  if (vendorId != null && existing.vendor_id !== vendorId) {
    patch.vendor_id = vendorId;
    reasons.push(`vendor(${existing.vendor_id ?? "none"}->${vendorId})`);
  }

  // Overwrite when we have a description AND it differs; a truncated stored value
  // is replaced by the fuller re-seeded text (do not clobber a full one with a
  // truncated one).
  const descriptionChanged =
    !!description &&
    !contradictsFamily(name, description) &&
    description !== (existing.description ?? "") &&
    !(
      looksTruncated(description) &&
      !!existing.description &&
      !looksTruncated(existing.description)
    );
  if (descriptionChanged) {
    patch.description = description;
    reasons.push("description");
  } else if (
    !!existing.description &&
    contradictsFamily(name, existing.description)
  ) {
    // Rows seeded before the description ranker landed can hold a blurb belonging
    // to a different model family; the sources no longer offer that text, so only
    // clearing heals them.
    patch.description = "";
    reasons.push("description(stale family)");
  }

  // The first tag drives the UI modality tab. A full sync builds the richest
  // tags; only correct the row when its leading tag is missing or the WRONG
  // type, so a good full-sync tag set is never clobbered. A context-size tag on
  // an image model is always wrong and the full sync will not remove it.
  const liveFirstTag = (existing.tags ?? "").split(",")[0]?.trim();
  const wantFirstTag = tags.split(",")[0];
  const staleContextTag =
    computed.isImageChannel &&
    (existing.tags ?? "")
      .split(",")
      .some((tag) => /^\d+(\.\d+)?[KM]?$/.test(tag.trim()));
  if (staleContextTag || (!!wantFirstTag && liveFirstTag !== wantFirstTag)) {
    patch.tags = tags;
    reasons.push(`tags(${liveFirstTag || "none"}->${wantFirstTag})`);
  }

  // Classifiers seeded while "moderation" still inferred as image carry an
  // image-generation endpoint; only the create path sets endpoints, so a
  // re-seed alone never heals the row.
  const wantEndpoints = isModerationModel(name)
    ? inferEndpoints(name)
    : undefined;
  if (!!wantEndpoints && (existing.endpoints ?? "") !== wantEndpoints) {
    patch.endpoints = wantEndpoints;
    reasons.push("endpoints");
  }
  return { patch, reasons };
}

export async function runMetadataSync(
  config: RuntimeConfig,
  opts?: { dryRun?: boolean },
): Promise<MetadataSyncResult> {
  const target = new NewApiClient(config.target, "target");
  const health = await target.healthCheck();
  if (!health.ok)
    throw new Error(
      t("ERROR.TARGET_HEALTH_CHECK_FAILED", {
        detail: health.error ?? "unknown",
      }),
    );

  const result: MetadataSyncResult = {
    total: 0,
    created: 0,
    patched: 0,
    skipped: 0,
    failed: 0,
    failedModels: [],
    renamedChannels: 0,
    renamedGroups: 0,
    passThroughEnabled: 0,
    paramOverrideChanged: 0,
    systemPromptChanged: 0,
    optionErrors: [],
  };

  // Dry-run previews the one metadata step that renames gateway rows (the
  // groupMapping pass) and writes nothing; the remaining steps are idempotent
  // re-seeds a normal run performs.
  if (opts?.dryRun) {
    const plan = planGroupRenames(await target.listChannels(), config);
    printGroupRenamePlan(plan);
    result.renamedGroups = plan.renames.length;
    result.dryRun = true;
    return result;
  }

  const filter = config.modelFilter ?? [];
  const inScope = (name: string) =>
    filter.length === 0 || matchesAnyPattern(name, filter);

  const [
    basellmEntries,
    openRouterDescriptions,
    existingModels,
    vendors,
    channels,
  ] = await Promise.all([
    fetchBasellmEntries(),
    fetchOpenRouterDescriptions(),
    target.listModels(),
    target.listVendors(),
    target.listChannels(),
  ]);
  const sources = await fetchAllPricingSources(basellmEntries);
  const reverseMapping = buildReverseMapping(config.modelMapping);
  const vendorIdCache = new Map<string, number | undefined>();

  result.renamedChannels = await normalizePublishedNames(
    target,
    channels,
    config,
  );
  // Before anything downstream reads channel names.
  const store = await OptionStore.load(target);
  result.renamedGroups = await applyGroupRenames(
    target,
    planGroupRenames(channels, config),
    store,
    channels,
  );

  result.passThroughEnabled = await reconcilePassThrough(target, channels);
  result.paramOverrideChanged = await reconcileParamOverride(
    target,
    channels,
    config,
  );
  result.systemPromptChanged = await reconcileSystemPrompt(
    target,
    channels,
    config,
  );

  const existingByName = new Map<string, ModelMeta>();
  for (const m of existingModels)
    if (m.model_name) existingByName.set(m.model_name, m);
  // Same inference as diff.ts: vanilla new-api has no metadata column, so its
  // rows never carry the field and a metadata patch there is a no-op that
  // would count as "patched" on every run.
  const supportsMetadata =
    existingModels.length === 0 ||
    existingModels.some((m) => m.metadata !== undefined);

  const allNames = new Set<string>([
    ...existingByName.keys(),
    ...publishedNamesFromChannels(channels),
  ]);
  const names = [...allNames].filter(inScope).sort();

  // Descriptions live in the models.description COLUMN (not the metadata JSON) and
  // are written only by a full sync run; re-seed them here too so a `metadata` run
  // picks up the full OpenRouter-frontend/ePhone text without a full run.
  const descriptionMap = buildMetadataMap({
    modelNames: new Set([...names, ...names.map((n) => toBareName(n))]),
    basellmEntries,
    openRouterDescriptions,
    modelMapping: config.modelMapping,
  });

  consola.info(t("CORE.METADATA.RESEED_START", { count: names.length }));
  result.total = names.length;

  const aiHordeModels = buildAiHordeModels(channels);
  const runwareModels = buildRunwareModels(channels);
  const imageChannelModels = new Set([...aiHordeModels, ...runwareModels]);

  // Diffusion checkpoints are named after the checkpoint, not its host, so name
  // inference mis-attributes them to whichever brand the name happens to contain:
  // nova-furry-xl reads as Amazon, autismmix-sdxl as Stability AI, juggernaut-xl as
  // AI Horde. The serving channel is the only reliable signal for these.
  // First writer wins, so a checkpoint served by both channels keeps one stable label
  // rather than flipping with channel order.
  const vendorByChannel = new Map<string, string>();
  for (const name of aiHordeModels) vendorByChannel.set(name, "aihorde");
  for (const name of runwareModels)
    if (!vendorByChannel.has(name)) vendorByChannel.set(name, "runware");

  for (const name of names) {
    // `{model}:free` published names have no `:free` key in the pricing sources;
    // fall back to the bare base so the alias inherits the real metadata.
    const modelType = imageChannelModels.has(name)
      ? "image"
      : inferModelType(name);
    const merged =
      buildModelMetadata({
        modelName: name,
        sources,
        reverseMapping,
        modelType,
      }) ??
      buildModelMetadata({
        modelName: toBareName(name),
        sources,
        reverseMapping,
        modelType,
      });

    // A checkpoint name can fuzzy-match a text model in the pricing sources
    // (flux-1-dev-runware picks up flux-1-dev's chat entry), which then renders a
    // context window on a model that has no such thing.
    if (merged && imageChannelModels.has(name)) {
      delete merged.maxInputTokens;
      delete merged.contextWindow;
      delete merged.maxOutputTokens;
      if (merged.mode === "chat") merged.mode = "image";
    }

    const canonical =
      vendorByChannel.get(name) ?? inferVendorFromModelName(name);
    const vendorId = canonical
      ? await resolveVendorId(target, vendors, vendorIdCache, canonical)
      : undefined;

    const existing = existingByName.get(name);

    const tags = buildTags(name, sources, reverseMapping, imageChannelModels);

    // Prefer the fuller of OpenRouter-frontend (descriptionMap) vs the pricing
    // sources (ePhone), matching the full-sync desired-models logic.
    const orDescription =
      descriptionMap.get(name)?.description ??
      descriptionMap.get(toBareName(name))?.description;
    const sourceDescription = resolveSourceMetadata(
      name,
      sources,
      reverseMapping,
    ).description;
    const description = pickBetterDescription(orDescription, sourceDescription);

    if (!existing) {
      const created = await target.createModel({
        model_name: name,
        ...(vendorId != null ? { vendor_id: vendorId } : {}),
        ...(merged ? { metadata: JSON.stringify(merged) } : {}),
        ...(description ? { description } : {}),
        endpoints: inferEndpoints(name),
        tags,
        status: 1,
      });
      if (created) result.created++;
      else {
        result.failed++;
        result.failedModels.push(name);
      }
      continue;
    }

    const row = planRowPatch(name, existing, {
      merged: supportsMetadata ? merged : undefined,
      vendorId,
      tags,
      description,
      isImageChannel: imageChannelModels.has(name),
    });
    if (row.reasons.length === 0) {
      result.skipped++;
      continue;
    }
    consola.info(`[metadata] patch ${name}: ${row.reasons.join(", ")}`);
    const patched = { ...existing, ...row.patch };
    if (await target.updateModel(patched)) {
      result.patched++;
    } else {
      result.failed++;
      result.failedModels.push(name);
    }
  }

  syncRateLimitOptions(store, config, allNames, inScope);

  // Order matters: grid collapse overrides the pipeline's flat prices, and
  // `:free` -> 0 overrides both.
  const snap: TargetSnapshot = {
    channels,
    models: existingModels,
    vendors,
    options: store.raw(),
  };
  await syncUpstreamPricing(store, config, snap, inScope);

  syncGridCollapse(store, config, inScope);

  const freeNames = [...allNames]
    .filter((name) => name.endsWith(":free") && inScope(name))
    .sort();
  syncFreePricing(store, freeNames, channels, inScope);
  const flushed = await store.flush(target, channels);
  const unpriced = store.unpricedLiveModels(channels);
  printPricingAudit(flushed, unpriced);
  result.optionErrors.push(
    ...flushed.errors.map((e) => `${e.key}: ${e.message}`),
  );
  if (unpriced.length > 0)
    result.optionErrors.push(
      `${unpriced.length} model(s) on enabled channels carry no price: ${unpriced.join(", ")}`,
    );

  // Keep the guest token's allowed-models in step with the served `:free`
  // catalog. Deliberately NOT freeNames: that list is inScope-filtered, and
  // model_limits is a wholesale overwrite, so a scoped run would evict every
  // free model outside its scope.
  await updateGuestTokenIfConfigured(target, channels);

  return result;
}

// Re-price the models current channels serve from a dry-run provider pipeline
// (read-only pricing fetch, canonical vote, cap, priceAdjustment; no probes, no
// tokens), touching only the names those channels publish.
async function syncUpstreamPricing(
  store: OptionStore,
  config: RuntimeConfig,
  snap: TargetSnapshot,
  inScope: (name: string) => boolean,
): Promise<void> {
  const served = [
    ...modelsOnChannels(snap.channels, {
      enabledOnly: false,
      includeAliases: false,
    }),
  ].filter(inScope);
  if (served.length === 0) return;

  // Scoped to kinds whose discovery is a read-only pricing fetch that honors
  // dryRun end to end: newapi (/api/pricing) and a7api (one marketplace
  // snapshot). nvidia/openrouter still run live discovery probes even
  // under dryRun, so including them would burn upstream test traffic.
  const newapiConfig: RuntimeConfig = {
    ...config,
    providers: config.providers.filter(
      (p) => p.type === "newapi" || p.type === "a7api",
    ),
  };
  if (newapiConfig.providers.length === 0) return;

  const result = await runProviderPipeline(newapiConfig, snap, {
    dryRun: true,
  });
  const opts = result.desired.options;

  // A served model the pipeline now flat-prices (modelPrice set) must NOT keep a
  // stale grid or ratio for the same name, or new-api would still bill the old
  // way. Clear those collisions; scoped to names we actually re-priced so we
  // never touch models priced elsewhere or left untouched.
  const flatPriced = new Set(served.filter((name) => name in opts.modelPrice));

  let changedKeys = 0;
  const counted = new Set<string>();
  for (const key of MODEL_OPTION_KEYS) {
    if (key === "ModelRequestRateLimitModels") continue;
    const computed: Record<string, unknown> = opts[MODEL_OPTION_FIELD[key]];
    const map = store.object(key);
    const set: Record<string, unknown> = {};
    const del: string[] = [];
    const clearsForFlat =
      key === "ModelRatio" ||
      key === "CompletionRatio" ||
      key === "ModelGridPricing";
    for (const name of served) {
      if (name in computed) {
        counted.add(name);
        if (stringify(map[name]) !== stringify(computed[name])) {
          set[name] = computed[name];
          changedKeys++;
        }
      } else if (clearsForFlat && flatPriced.has(name) && name in map) {
        del.push(name);
        changedKeys++;
      }
    }
    store.setEntries(key, set);
    store.deleteEntries(key, del);
  }

  // GroupRatio is keyed by channel-group name (not model name), so it falls
  // outside the served-name intersection above. The dry-run pipeline only emits
  // group ratios for in-scope newapi channels, so merge those over the live map
  // (preserving every out-of-scope group). This is what carries the per-request
  // upstream-cost x adjustment group ratio computed in compute.ts.
  if (Object.keys(opts.groupRatio).length > 0) {
    const gr = store.object("GroupRatio");
    for (const [group, ratio] of Object.entries(opts.groupRatio))
      if (gr[group] !== ratio) changedKeys++;
    // AutoGroups + UserUsableGroups are channel-routing membership, not pricing,
    // so the apply path normally owns them. But a partial `sync run` can erode
    // them: a group present in abilities + GroupRatio yet absent from AutoGroups
    // is invisible (the auto token can't route to it, so the catalog hides the
    // model). Only groups an ENABLED channel carries: the dry-run pipeline emits
    // every candidate merchant, probed or not, and publishing those hands the
    // token group picker pins that route nowhere.
    const routable = groupsOnChannels(snap.channels, { enabledOnly: true });
    const ownUsable: Record<string, string> = {};
    for (const [g, label] of Object.entries(opts.userUsableGroups))
      if (routable.has(g)) ownUsable[g] = label;
    const before = [store.autoGroups(), store.object("UserUsableGroups")].map(
      (v) => stringify(v),
    );
    store.mergeGroups({
      ratio: opts.groupRatio,
      usable: ownUsable,
      auto: opts.autoGroups.filter((g) => routable.has(g)),
    });
    const after = [store.autoGroups(), store.object("UserUsableGroups")].map(
      (v) => stringify(v),
    );
    changedKeys += before.filter((v, i) => v !== after[i]).length;
  }
  consola.info(
    t("CORE.METADATA.UPSTREAM_PRICING_SYNCED", {
      count: counted.size,
      changed: changedKeys,
    }),
  );

  // a7 pauses pins on merchant reprice and the paused lane errors (no
  // smart-routing fallback); accepting the price notices here puts pin upkeep
  // on the metadata cron's cadence instead of the full-sync's.
  for (const p of config.providers) {
    if (p.type !== "a7api") continue;
    const pins = await acceptPriceNotices(p);
    consola.info(
      `[${p.name}] price changes accepted: ${pins.accepted}, left paused: ${pins.leftPaused}`,
    );
  }
}

// Collapse every config `modelPricingGrid` (across all providers) to a single
// flat per-request ModelPrice = the most expensive grid row, and clear the grid
// + any ratio for that name. new-api prices globally per model name, so a grid
// and a per-request provider of the same model cannot coexist; the max-row flat
// price bills consistently and never underbills regardless of resolution/channel.
function syncGridCollapse(
  store: OptionStore,
  config: RuntimeConfig,
  inScope: (name: string) => boolean,
): void {
  // Mapped published name -> flat max grid price (duration/mode grids, adaptor-handled).
  // Resolution grids (gemini-image 1K/2K/4K) are kept as real ModelGridPricing (the gateway
  // applies them via GetGridPrice); their base ModelPrice is the cheapest tier.
  const flat: Record<string, number> = {};
  const resolutionGrids: Record<string, Record<string, string | number>[]> = {};
  for (const provider of config.providers) {
    const grids = getPricingGridFromEnabledModels(provider.enabledModels);
    for (const [modelName, rows] of Object.entries(grids)) {
      const mapped = config.modelMapping?.[modelName] ?? modelName;
      if (!inScope(mapped)) continue;
      const isResolutionGrid =
        rows.length > 0 &&
        rows.every(
          (row) => typeof row.Resolution === "string" && row.Resolution !== "",
        );
      if (isResolutionGrid) {
        resolutionGrids[mapped] = rows;
        const min = rows.reduce((m, row) => {
          const p = Number(row.Pricing);
          return Number.isFinite(p) && p > 0 && p < m ? p : m;
        }, Infinity);
        if (Number.isFinite(min)) flat[mapped] = min;
        continue;
      }
      const max = rows.reduce((m, row) => {
        const p = Number(row.Pricing);
        return Number.isFinite(p) && p > m ? p : m;
      }, 0);
      if (max > 0) flat[mapped] = Math.max(flat[mapped] ?? 0, max);
    }
  }

  const names = Object.keys(flat);
  if (names.length === 0) return;
  const r4 = (n: number) => Math.round(n * 10000) / 10000;

  let changed = 0;
  const price = store.object("ModelPrice");
  const grid = store.object("ModelGridPricing");
  for (const name of names) {
    const flatPrice = r4(flat[name]!);
    if (price[name] !== flatPrice) {
      store.setEntries("ModelPrice", { [name]: flatPrice });
      changed++;
    }
    const rows = resolutionGrids[name];
    if (rows) {
      if (stringify(grid[name]) !== stringify(rows)) {
        store.setEntries("ModelGridPricing", { [name]: rows });
        changed++;
      }
    } else if (name in grid) {
      store.deleteEntries("ModelGridPricing", [name]);
      changed++;
    }
    for (const key of ["ModelRatio", "CompletionRatio", "ModelQuotaType"])
      if (name in store.object(key)) {
        store.deleteEntries(key, [name]);
        changed++;
      }
  }

  consola.info(
    t("CORE.METADATA.GRID_COLLAPSED", {
      count: names.length,
      changed,
    }),
  );
}

// Every served `:free` model is ratio 0, and so is every group serving one: the
// zero-balance billing gate keys off GroupRatio, and an unlisted group defaults
// to 1.0 (paid), which blocked $0 users from free GLM channels whose group the
// pipeline never wrote.
function syncFreePricing(
  store: OptionStore,
  freeNames: string[],
  channels: Channel[],
  inScope: (name: string) => boolean,
): void {
  if (freeNames.length === 0) return;

  let changed = 0;
  for (const key of ["ModelRatio", "CompletionRatio"]) {
    const map = store.object(key);
    const zero = freeNames.filter((name) => map[name] !== 0);
    store.setEntries(key, Object.fromEntries(zero.map((name) => [name, 0])));
    changed += zero.length;
  }

  const freeGroups = groupsOnChannels(
    channels.filter((ch) =>
      parseModelList(ch.models).some(
        (name) => name.endsWith(":free") && inScope(name),
      ),
    ),
    { enabledOnly: false },
  );
  const gr = store.object("GroupRatio");
  const zeroGroups = [...freeGroups].filter((g) => gr[g] !== 0);
  store.setEntries(
    "GroupRatio",
    Object.fromEntries(zeroGroups.map((g) => [g, 0])),
  );
  changed += zeroGroups.length;

  consola.info(
    t("CORE.METADATA.FREE_PRICING_SYNCED", {
      count: freeNames.length,
      changed,
    }),
  );
}

function syncRateLimitOptions(
  store: OptionStore,
  config: RuntimeConfig,
  publishedNames: Set<string>,
  inScope: (name: string) => boolean,
): void {
  if (!config.rateLimit) return;
  const desired = expandRateLimitModels(publishedNames, config.rateLimit);
  // A `--models` run manages only in-scope keys; the rest keep their value.
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(
    store.object("ModelRequestRateLimitModels"),
  ))
    if (!inScope(k)) merged[k] = v;
  for (const [k, v] of Object.entries(desired)) merged[k] = v;
  store.replace("ModelRequestRateLimitModels", JSON.stringify(merged));
}

export function printMetadataSummary(result: MetadataSyncResult): void {
  if (result.dryRun) {
    consola.info(
      `[metadata] dry-run: ${result.renamedGroups} group rename(s) planned, nothing written`,
    );
    return;
  }
  consola.success(
    t("CORE.METADATA.RESEED_DONE", {
      patched: result.patched,
      skipped: result.skipped,
      failed: result.failed,
    }),
  );
  if (result.created > 0)
    consola.info(`[metadata] created ${result.created} missing model rows`);
  if (result.renamedChannels > 0)
    consola.info(
      `[metadata] renamed published names on ${result.renamedChannels} channels`,
    );
  if (result.renamedGroups > 0)
    consola.info(
      `[metadata] renamed ${result.renamedGroups} channels to their spliced group labels`,
    );
  if (result.passThroughEnabled > 0)
    consola.info(
      `[metadata] enabled body pass-through on ${result.passThroughEnabled} media channels`,
    );
  if (result.paramOverrideChanged > 0)
    consola.info(
      `[metadata] reconciled disable-thinking param_override on ${result.paramOverrideChanged} channels`,
    );
  if (result.systemPromptChanged > 0)
    consola.info(
      `[metadata] reconciled system_prompt on ${result.systemPromptChanged} channels`,
    );
  if (result.failedModels.length > 0)
    consola.warn(
      t("CORE.METADATA.RESEED_FAILED_LIST", {
        items: result.failedModels.join(", "),
      }),
    );
  for (const error of result.optionErrors)
    consola.error(`[metadata] option error: ${error}`);
}
