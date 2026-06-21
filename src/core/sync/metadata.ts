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
import {
  buildModelMetadata,
  deriveTagsFromMetadata,
  fetchAllPricingSources,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import type { PricingSource } from "@core/pricing/sources/types";
import { isRoutingOnlyAlias } from "@core/sync/pipeline/desired-models";
import type { Channel, ModelMeta, Vendor } from "@core/types";
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
    .filter((tag) => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()))
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

  const [basellmEntries, existingModels, vendors, channels] =
    await Promise.all([
      fetchBasellmEntries(),
      target.listModels(),
      target.listVendors(),
      target.listChannels(),
    ]);
  const sources = await fetchAllPricingSources(basellmEntries);
  const reverseMapping = buildReverseMapping(config.modelMapping);
  const vendorIdCache = new Map<string, number | undefined>();

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

  return result;
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
  if (result.failedModels.length > 0)
    consola.warn(
      t("CORE.METADATA.RESEED_FAILED_LIST", {
        items: result.failedModels.join(", "),
      }),
    );
}
