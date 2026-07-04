// Metadata-only re-seed: ensure every PUBLISHED model (every name served by a
// channel) has a models-table row carrying vendor + metadata (release date,
// params, context, description), WITHOUT any probing/testing, pricing, or channel
// changes. Missing rows are CREATED, stale rows are UPDATED; nothing is skipped
// just because a row lacked metadata before.
//
// Why this exists as a first-class command:
//  1. The first sync after `reset` writes empty metadata (the snapshot is empty,
//     so diff.ts can't detect metadata support). This re-seeds without a full run.
//  2. Metadata sources update independently of pricing/availability; refreshing
//     them shouldn't require re-probing every model (slow + costs upstream calls).
//  3. Published names that only ever got an abilities/channel entry (never a
//     models-table row) show blank vendor/date/context in the catalog; this
//     backfills them.
//
// The published universe is derived from channels (each channel's `models` list,
// minus routing-only `[1m]` aliases), unioned with existing models-table rows.
// Vendor is inferred from the name and resolved to a vendor_id (creating the
// vendor row if absent), so rows synced before a matcher existed get their icon
// backfilled too.

import { toBareName } from "@core/catalog/bare-name";
import {
  ENDPOINT_DEFAULT_PATHS,
  MODEL_TYPE_CANONICAL_ENDPOINT,
  normalizeEndpointType,
} from "@core/catalog/constants/endpoints";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import {
  buildReverseMapping,
  matchesAnyPattern,
  parseModelList,
} from "@core/catalog/constants/patterns";
import {
  findVendorByAlias,
  inferVendorFromModelName,
  VENDOR_MATCHERS,
} from "@core/catalog/constants/vendor-matchers";
import { fetchBasellmEntries } from "@core/catalog/metadata";
import type { RuntimeConfig } from "@core/config";
import { getPricingGridFromEnabledModels } from "@core/config";
import {
  buildModelMetadata,
  deriveTagsFromMetadata,
  fetchAllPricingSources,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import type { PricingSource } from "@core/pricing/sources/types";
import { updateGuestTokenFromNames } from "@core/sync/guest-token";
import { runProviderPipeline } from "@core/sync/pipeline";
import { isRoutingOnlyAlias } from "@core/sync/pipeline/desired-models";
import { expandRateLimitModels } from "@core/sync/pipeline/option-maps";
import type { Channel, ModelMeta, TargetSnapshot, Vendor } from "@core/types";
import { MANAGED_OPTION_KEYS } from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";

export interface MetadataSyncResult {
  total: number;
  created: number;
  patched: number;
  skipped: number;
  failed: number;
  failedModels: string[];
  renamedChannels: number;
  passThroughEnabled: number;
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
function inferEndpoints(name: string): string | undefined {
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
): string {
  const modelType = inferModelType(name);
  const typeTag = modelType.charAt(0).toUpperCase() + modelType.slice(1);
  const sourceTags = deriveTagsFromMetadata(
    resolveSourceMetadata(name, sources, reverseMapping),
  );
  const seen = new Set<string>();
  return [typeTag, ...sourceTags]
    .filter(
      (tag) =>
        tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()),
    )
    .join(",");
}

// Every published model name a channel serves (minus routing-only [1m] aliases).
function publishedNamesFromChannels(channels: Channel[]): Set<string> {
  const names = new Set<string>();
  for (const ch of channels)
    for (const name of parseModelList(ch.models))
      if (!isRoutingOnlyAlias(name)) names.add(name);
  return names;
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

// Media channels (image/video/audio/embedding) must forward the raw client body so non-struct fields
// (image_urls, vendor extras) survive new-api's ImageRequest re-marshal, which drops unknown fields.
// Patch pass_through_body_enabled onto any media channel missing it. Gateway-only, no probing.
async function reconcilePassThrough(
  target: NewApiClient,
  channels: Channel[],
): Promise<number> {
  let enabled = 0;
  for (const ch of channels) {
    // ALI (17) DashScope channels need the gateway's native-shape conversion
    // (input.messages, model rewrite); pass-through would forward the raw OpenAI
    // body and 400/404. Never enable pass-through on them.
    if (ch.type === CHANNEL_TYPES.ALI) continue;
    const isMedia = parseModelList(ch.models).some(
      (name) => !isRoutingOnlyAlias(name) && inferModelType(name) !== "text",
    );
    if (!isMedia) continue;

    let setting: Record<string, unknown> = {};
    if (ch.setting) {
      try {
        setting = JSON.parse(ch.setting);
      } catch {
        // Unparseable existing setting: skip rather than clobber other fields.
        continue;
      }
    }
    if (setting.pass_through_body_enabled === true) continue;

    setting.pass_through_body_enabled = true;
    const nextSetting = JSON.stringify(setting);
    const ok = await target.updateChannel({ ...ch, setting: nextSetting });
    if (ok) {
      ch.setting = nextSetting;
      enabled++;
      consola.info(
        t("CORE.METADATA.CHANNEL_PASSTHROUGH_ENABLED", { name: ch.name }),
      );
    }
  }
  return enabled;
}

export async function runMetadataSync(
  config: RuntimeConfig,
): Promise<MetadataSyncResult> {
  const target = new NewApiClient(config.target, "target");
  const health = await target.healthCheck();
  if (!health.ok)
    throw new Error(
      t("ERROR.TARGET_HEALTH_CHECK_FAILED", {
        detail: health.error ?? "unknown",
      }),
    );

  const filter = config.modelFilter ?? [];
  const inScope = (name: string) =>
    filter.length === 0 || matchesAnyPattern(name, filter);

  const [basellmEntries, existingModels, vendors, channels] = await Promise.all(
    [
      fetchBasellmEntries(),
      target.listModels(),
      target.listVendors(),
      target.listChannels(),
    ],
  );
  const sources = await fetchAllPricingSources(basellmEntries);
  const reverseMapping = buildReverseMapping(config.modelMapping);
  const vendorIdCache = new Map<string, number | undefined>();

  // Re-derive published names against the current modelMapping and rename any
  // stale ones on their channels (e.g. a `{slug}-free:free` left over from before
  // a `{slug}-free -> {canonical}` mapping existed). Gateway-only, no probing.
  const renamedChannels = await normalizePublishedNames(
    target,
    channels,
    config,
  );

  // Ensure media channels forward the raw body (image_urls / vendor extras survive new-api re-marshal).
  const passThroughEnabled = await reconcilePassThrough(target, channels);

  // Union of every served name and every existing models-table row.
  const existingByName = new Map<string, ModelMeta>();
  for (const m of existingModels)
    if (m.model_name) existingByName.set(m.model_name, m);

  const allNames = new Set<string>([
    ...existingByName.keys(),
    ...publishedNamesFromChannels(channels),
  ]);
  const names = [...allNames].filter(inScope).sort();

  consola.info(t("CORE.METADATA.RESEED_START", { count: names.length }));

  const result: MetadataSyncResult = {
    total: names.length,
    created: 0,
    patched: 0,
    skipped: 0,
    failed: 0,
    failedModels: [],
    renamedChannels,
    passThroughEnabled,
  };

  for (const name of names) {
    // `{model}:free` published names have no `:free` key in the pricing sources;
    // fall back to the bare base so the alias inherits the real metadata.
    const merged =
      buildModelMetadata({ modelName: name, sources, reverseMapping }) ??
      buildModelMetadata({
        modelName: toBareName(name),
        sources,
        reverseMapping,
      });

    const canonical = inferVendorFromModelName(name);
    const vendorId = canonical
      ? await resolveVendorId(target, vendors, vendorIdCache, canonical)
      : undefined;

    const existing = existingByName.get(name);

    const tags = buildTags(name, sources, reverseMapping);

    if (!existing) {
      const created = await target.createModel({
        model_name: name,
        ...(vendorId != null ? { vendor_id: vendorId } : {}),
        ...(merged ? { metadata: JSON.stringify(merged) } : {}),
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

    const nextMetadata = merged ? JSON.stringify(merged) : existing.metadata;
    const metadataChanged =
      merged != null && (existing.metadata ?? "") !== nextMetadata;
    const vendorChanged = vendorId != null && existing.vendor_id !== vendorId;

    // The first tag drives the UI modality tab. A full sync builds the richest
    // tags; only correct the row when its leading tag is missing or the WRONG
    // type (e.g. an audio model left untagged -> mis-filed under Text), so we
    // never clobber a good full-sync tag set.
    const liveFirstTag = (existing.tags ?? "").split(",")[0]?.trim();
    const wantFirstTag = tags.split(",")[0];
    const tagsChanged = !!wantFirstTag && liveFirstTag !== wantFirstTag;

    if (!metadataChanged && !vendorChanged && !tagsChanged) {
      result.skipped++;
      continue;
    }

    const patched = {
      ...existing,
      ...(merged ? { metadata: nextMetadata } : {}),
      ...(vendorId != null ? { vendor_id: vendorId } : {}),
      ...(tagsChanged ? { tags } : {}),
    };
    if (await target.updateModel(patched)) {
      result.patched++;
    } else {
      result.failed++;
      result.failedModels.push(name);
    }
  }

  await syncRateLimitOptions(target, config, allNames, inScope);

  // Recompute paid pricing for models the current channels serve, pulled from the
  // upstream newapi providers (cap + canonical vote + priceAdjustment), without
  // probing. Runs before syncFreePricing so `:free` -> 0 still wins below.
  const options = await target.getOptions([...MANAGED_OPTION_KEYS]);
  const snap: TargetSnapshot = {
    channels,
    models: existingModels,
    vendors,
    options,
  };
  await syncUpstreamPricing(target, config, snap, inScope);

  // Collapse EVERY config pricing grid (all providers, served or not) to a flat
  // per-request price = the most expensive grid row. Runs after syncUpstreamPricing
  // so this max-grid price wins over any flat price the pipeline set.
  await syncGridCollapse(target, config, inScope);

  // Every served `:free` name must be priced at ratio 0 (always free). Paid
  // ("general") models keep their existing ratios untouched. This also backfills
  // names that drifted (e.g. a published `minimax-m3-thinking:free` whose ratio
  // key was stuck under the old `-free:free` name) so they stop hitting the
  // "not priced by the administrator" gate.
  const freeNames = [...allNames]
    .filter((name) => name.endsWith(":free") && inScope(name))
    .sort();
  await syncFreePricing(target, freeNames, channels, inScope);

  // Keep the guest token's allowed-models in step with the served `:free`
  // catalog. Status-agnostic by design: a free model whose channel is currently
  // disabled/banned stays in the allowlist so it works the instant the channel
  // recovers, without waiting for a full `sync run`.
  await updateGuestTokenFromNames(target, freeNames);

  return result;
}

// Recompute pricing from the upstream newapi providers for models the current
// target channels serve, then write only those keys (merge-preserving everything
// else). Runs the provider pipeline in dry-run mode: fetchPricing per provider
// (read-only), canonical vote, computePricedPlan (hard cap + per-provider
// priceAdjustment), buildOptionMaps - but NO probes/tests/token-creation, and the
// pipeline itself writes nothing. We then intersect the computed option maps with
// the names current channels publish so out-of-scope/paid-elsewhere entries are
// untouched.
async function syncUpstreamPricing(
  target: NewApiClient,
  config: RuntimeConfig,
  snap: TargetSnapshot,
  inScope: (name: string) => boolean,
): Promise<void> {
  const served = new Set<string>();
  for (const ch of snap.channels)
    for (const name of parseModelList(ch.models))
      if (!isRoutingOnlyAlias(name) && inScope(name)) served.add(name);
  if (served.size === 0) return;

  // Only newapi providers expose an /api/pricing to read paid ratios from; the
  // other provider kinds (nvidia/openrouter/sub2api) would run live probes even
  // under dryRun (their processors don't honor the flag), so scope the pipeline
  // to newapi providers to avoid wasted upstream test traffic.
  const newapiConfig: RuntimeConfig = {
    ...config,
    providers: config.providers.filter((p) => p.type === "newapi"),
  };
  if (newapiConfig.providers.length === 0) return;

  const result = await runProviderPipeline(newapiConfig, snap, {
    dryRun: true,
  });
  const opts = result.desired.options;

  // Same field -> option-key map the apply path uses (sync/diff.ts).
  const MODEL_OPTIONS: [string, Record<string, unknown>][] = [
    ["ModelRatio", opts.modelRatio],
    ["CompletionRatio", opts.completionRatio],
    ["ModelPrice", opts.modelPrice],
    ["ImageRatio", opts.imageRatio],
    ["CacheRatio", opts.cacheRatio],
    ["CreateCacheRatio", opts.createCacheRatio],
    ["AudioRatio", opts.audioRatio],
    ["AudioCompletionRatio", opts.audioCompletionRatio],
    ["ModelQuotaType", opts.modelQuotaType],
    ["ModelGridPricing", opts.modelGridPricing],
    ["billing_setting.billing_mode", opts.billingMode],
    ["billing_setting.billing_expr", opts.billingExpr],
  ];

  const current = await target.getOptions(MODEL_OPTIONS.map(([k]) => k));

  // A served model the pipeline now flat-prices (modelPrice set) must NOT keep a
  // stale grid or ratio for the same name, or new-api would still bill the old
  // way. Clear those collisions; scoped to names we actually re-priced so we
  // never touch models priced elsewhere or left untouched.
  const flatPriced = new Set<string>();
  for (const name of served) if (name in opts.modelPrice) flatPriced.add(name);

  let pricedNames = 0;
  let changedKeys = 0;
  const counted = new Set<string>();
  for (const [key, computed] of MODEL_OPTIONS) {
    let map: Record<string, unknown> = {};
    try {
      map = JSON.parse(current[key] || "{}");
    } catch {
      map = {};
    }
    let dirty = false;
    const isRatioKey = key === "ModelRatio" || key === "CompletionRatio";
    const isGridKey = key === "ModelGridPricing";
    for (const name of served) {
      if (name in computed) {
        counted.add(name);
        if (map[name] !== computed[name]) {
          map[name] = computed[name];
          dirty = true;
          changedKeys++;
        }
      } else if (
        (isGridKey || isRatioKey) &&
        flatPriced.has(name) &&
        name in map
      ) {
        delete map[name];
        dirty = true;
        changedKeys++;
      }
    }
    if (dirty) await target.updateOption(key, JSON.stringify(map));
  }

  // GroupRatio is keyed by channel-group name (not model name), so it falls
  // outside the served-name intersection above. The dry-run pipeline only emits
  // group ratios for in-scope newapi channels, so merge those over the live map
  // (preserving every out-of-scope group). This is what carries the per-request
  // upstream-cost x adjustment group ratio computed in compute.ts.
  const computedGroupRatio = opts.groupRatio;
  if (Object.keys(computedGroupRatio).length > 0) {
    const liveGroupRatio = await target.getOptions(["GroupRatio"]);
    let gr: Record<string, number> = {};
    try {
      gr = JSON.parse(liveGroupRatio["GroupRatio"] || "{}");
    } catch {
      gr = {};
    }
    let grDirty = false;
    for (const [group, ratio] of Object.entries(computedGroupRatio)) {
      if (gr[group] !== ratio) {
        gr[group] = ratio;
        grDirty = true;
        changedKeys++;
      }
    }
    if (grDirty) await target.updateOption("GroupRatio", JSON.stringify(gr));

    // AutoGroups + UserUsableGroups are channel-routing membership, not pricing, so
    // the apply path normally owns them. But a partial `sync run` can erode them: a
    // group present in abilities + GroupRatio yet absent from AutoGroups is invisible
    // (the auto token can't route to it, so the catalog hides the model). doubao image
    // groups drifted out this way. Union the dry-run's computed groups over the live
    // lists (never remove — metadata only adds in-scope groups, preserves the rest),
    // re-sorted cheapest-first to match the apply path.
    const liveGM = await target.getOptions(["AutoGroups", "UserUsableGroups"]);
    let liveAuto: string[] = [];
    let liveUsable: Record<string, string> = {};
    try {
      liveAuto = JSON.parse(liveGM["AutoGroups"] || "[]");
    } catch {
      liveAuto = [];
    }
    try {
      liveUsable = JSON.parse(liveGM["UserUsableGroups"] || "{}");
    } catch {
      liveUsable = {};
    }
    const mergedAuto = [...new Set([...liveAuto, ...opts.autoGroups])].sort(
      (a, b) => (gr[a] ?? 1) - (gr[b] ?? 1),
    );
    if (JSON.stringify(mergedAuto) !== JSON.stringify(liveAuto)) {
      await target.updateOption("AutoGroups", JSON.stringify(mergedAuto));
      changedKeys++;
    }
    const mergedUsable = { ...liveUsable, ...opts.userUsableGroups };
    if (JSON.stringify(mergedUsable) !== JSON.stringify(liveUsable)) {
      await target.updateOption(
        "UserUsableGroups",
        JSON.stringify(mergedUsable),
      );
      changedKeys++;
    }
  }
  pricedNames = counted.size;

  consola.info(
    t("CORE.METADATA.UPSTREAM_PRICING_SYNCED", {
      count: pricedNames,
      changed: changedKeys,
    }),
  );
}

// Collapse every config `modelPricingGrid` (across all providers) to a single
// flat per-request ModelPrice = the most expensive grid row, and clear the grid
// + any ratio for that name. new-api prices globally per model name, so a grid
// and a per-request provider of the same model cannot coexist; the max-row flat
// price bills consistently and never underbills regardless of resolution/channel.
async function syncGridCollapse(
  target: NewApiClient,
  config: RuntimeConfig,
  inScope: (name: string) => boolean,
): Promise<void> {
  // Mapped published name -> max grid price, across every provider's grids.
  const flat: Record<string, number> = {};
  for (const provider of config.providers) {
    if (provider.type === "private") continue;
    const grids = getPricingGridFromEnabledModels(provider.enabledModels);
    for (const [modelName, rows] of Object.entries(grids)) {
      const mapped = config.modelMapping?.[modelName] ?? modelName;
      if (!inScope(mapped)) continue;
      const max = rows.reduce((m, row) => {
        const p = Number(row.Pricing);
        return Number.isFinite(p) && p > m ? p : m;
      }, 0);
      if (max > 0) flat[mapped] = Math.max(flat[mapped] ?? 0, max);
    }
  }
  const names = Object.keys(flat);
  if (names.length === 0) return;

  const KEYS = [
    "ModelPrice",
    "ModelGridPricing",
    "ModelRatio",
    "CompletionRatio",
  ];
  const current = await target.getOptions(KEYS);
  const r4 = (n: number) => Math.round(n * 10000) / 10000;

  let changed = 0;
  for (const key of KEYS) {
    let map: Record<string, unknown> = {};
    try {
      map = JSON.parse(current[key] || "{}");
    } catch {
      map = {};
    }
    let dirty = false;
    for (const name of names) {
      if (key === "ModelPrice") {
        const price = r4(flat[name]!);
        if (map[name] !== price) {
          map[name] = price;
          dirty = true;
          changed++;
        }
      } else if (name in map) {
        delete map[name];
        dirty = true;
        changed++;
      }
    }
    if (dirty) await target.updateOption(key, JSON.stringify(map));
  }

  consola.info(
    t("CORE.METADATA.GRID_COLLAPSED", {
      count: names.length,
      changed,
    }),
  );
}

// Force ratio 0 for every served `:free` model, preserving all other (paid)
// entries verbatim. The gateway stores ModelRatio/CompletionRatio as single JSON
// blobs, so we read, set the in-scope free keys to 0, and write back the merge.
// ALSO forces GroupRatio 0 for every channel-group serving a `:free` model: the
// zero-balance billing gate keys off GroupRatio, and an unlisted group defaults
// to 1.0 (paid), which blocked $0 users from free GLM channels whose group was
// never written by the pipeline.
async function syncFreePricing(
  target: NewApiClient,
  freeNames: string[],
  channels: Channel[],
  inScope: (name: string) => boolean,
): Promise<void> {
  if (freeNames.length === 0) return;

  const KEYS = ["ModelRatio", "CompletionRatio"];
  const current = await target.getOptions(KEYS);

  let changed = 0;
  for (const key of KEYS) {
    let map: Record<string, number> = {};
    try {
      map = JSON.parse(current[key] || "{}");
    } catch {
      map = {};
    }
    let dirty = false;
    for (const name of freeNames) {
      if (map[name] !== 0) {
        map[name] = 0;
        dirty = true;
        changed++;
      }
    }
    if (dirty) await target.updateOption(key, JSON.stringify(map));
  }

  // A channel-group is free when it serves any in-scope `:free` model; force its
  // GroupRatio to 0 so the gateway treats it as free for zero-balance users.
  const freeGroups = new Set<string>();
  for (const ch of channels) {
    if (!ch.group) continue;
    const servesFree = parseModelList(ch.models).some(
      (name) => name.endsWith(":free") && inScope(name),
    );
    if (servesFree)
      for (const g of ch.group.split(",").map((s) => s.trim()))
        if (g) freeGroups.add(g);
  }

  let groupChanged = 0;
  if (freeGroups.size > 0) {
    const liveGr = await target.getOptions(["GroupRatio"]);
    let gr: Record<string, number> = {};
    try {
      gr = JSON.parse(liveGr["GroupRatio"] || "{}");
    } catch {
      gr = {};
    }
    let grDirty = false;
    for (const g of freeGroups) {
      if (gr[g] !== 0) {
        gr[g] = 0;
        grDirty = true;
        groupChanged++;
      }
    }
    if (grDirty) await target.updateOption("GroupRatio", JSON.stringify(gr));
  }

  consola.info(
    t("CORE.METADATA.FREE_PRICING_SYNCED", {
      count: freeNames.length,
      changed: changed + groupChanged,
    }),
  );
}

// Push the per-model rate-limit option (and new-user scalars) the same way a full
// sync does, so `sync metadata` keeps the gateway's rate limits in step with the
// `:free` catalog. Out-of-scope entries (under a `--models` filter) are preserved.
// No-op when config carries no `rateLimit` block.
async function syncRateLimitOptions(
  target: NewApiClient,
  config: RuntimeConfig,
  publishedNames: Set<string>,
  inScope: (name: string) => boolean,
): Promise<void> {
  if (!config.rateLimit) return;

  const desired = expandRateLimitModels(publishedNames, config.rateLimit);

  const current = await target.getOptions(["ModelRequestRateLimitModels"]);

  // Preserve out-of-scope entries: in a partial run only in-scope `:free` keys are
  // managed; everything else keeps its existing value.
  let existing: Record<string, number[]> = {};
  try {
    existing = JSON.parse(current.ModelRequestRateLimitModels || "{}");
  } catch {
    existing = {};
  }
  const merged: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(existing)) if (!inScope(k)) merged[k] = v;
  for (const [k, v] of Object.entries(desired)) merged[k] = v;

  const updates: Record<string, string> = {
    ModelRequestRateLimitModels: JSON.stringify(merged),
  };

  for (const [key, value] of Object.entries(updates)) {
    if (current[key] !== value) await target.updateOption(key, value);
  }
}

export function printMetadataSummary(result: MetadataSyncResult): void {
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
  if (result.passThroughEnabled > 0)
    consola.info(
      `[metadata] enabled body pass-through on ${result.passThroughEnabled} media channels`,
    );
  if (result.failedModels.length > 0)
    consola.warn(
      t("CORE.METADATA.RESEED_FAILED_LIST", {
        items: result.failedModels.join(", "),
      }),
    );
}
