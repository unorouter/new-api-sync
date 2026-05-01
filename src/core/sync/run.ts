import {
  findVendorByAlias,
  forEachVendor,
  VENDOR_MATCHERS,
} from "@core/catalog/constants/vendor-matchers";
import type { RuntimeConfig } from "@core/config";
import { throwIfRunAborted } from "@core/runtime";
import { applySyncDiff } from "@core/sync/apply";
import { buildSyncDiff } from "@core/sync/diff";
import { updateGuestTokenIfConfigured } from "@core/sync/guest-token";
import { runProviderPipeline } from "@core/sync/pipeline";
import type { ResetResult } from "@core/sync/reset";
import { loadAuthenticityBlacklist } from "@core/testing/authenticity";
import { recordRunSummary, writeTestReport } from "@core/testing/runner";
import type { DesiredState, SyncRunResult, TargetSnapshot } from "@core/types";
import { MANAGED_OPTION_KEYS } from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";

async function ensureVendors(
  client: NewApiClient,
  desired: DesiredState,
  snap: TargetSnapshot,
): Promise<number> {
  const neededVendors = new Set<string>();
  for (const model of desired.models.values()) {
    if (model.vendor) neededVendors.add(model.vendor.toLowerCase());
  }

  // Build a lookup: canonical vendor name → existing vendor (by name or alias)
  const existingByCanonical = new Map<string, (typeof snap.vendors)[0]>();
  forEachVendor((canonical) => {
    const found = findVendorByAlias(snap.vendors, canonical);
    if (found) existingByCanonical.set(canonical, found);
  });

  let changed = 0;
  for (const vendor of neededVendors) {
    const matcher = VENDOR_MATCHERS[vendor];
    const displayName =
      matcher?.displayName ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
    const icon = matcher?.icon;

    const existing = existingByCanonical.get(vendor);
    if (existing) {
      // Upsert: update if icon or name changed
      if (existing.icon !== icon || existing.name !== displayName) {
        const ok = await client.updateVendor({
          id: existing.id,
          name: displayName,
          icon,
        });
        if (ok) {
          consola.info(
            t("CORE.SYNC.VENDOR_UPDATED", {
              name: displayName,
              id: existing.id,
              icon: icon ?? t("CORE.SYNC.ICON_NONE"),
            }),
          );
          changed++;
        }
      }
      continue;
    }

    // Create new vendor
    const result = await client.createVendor({ name: displayName, icon });
    if (result) {
      consola.info(
        t("CORE.SYNC.VENDOR_CREATED", {
          name: displayName,
          id: result.id,
          icon: icon ?? t("CORE.SYNC.ICON_NONE"),
        }),
      );
      changed++;
    } else {
      consola.warn(t("CORE.SYNC.VENDOR_CREATE_FAILED", { name: displayName }));
    }
  }
  return changed;
}

async function snapshot(client: NewApiClient): Promise<TargetSnapshot> {
  const [channels, models, vendors, options] = await Promise.all([
    client.listChannels(),
    client.listModels(),
    client.listVendors(),
    client.getOptions([...MANAGED_OPTION_KEYS]),
  ]);
  return { channels, models, vendors, options };
}

export async function runSync(config: RuntimeConfig): Promise<SyncRunResult> {
  const start = Date.now();
  const target = new NewApiClient(config.target, "target");
  loadAuthenticityBlacklist();

  const health = await target.healthCheck();
  if (!health.ok) {
    throw new Error(
      t("ERROR.TARGET_HEALTH_CHECK_FAILED", {
        detail: health.error ?? "unknown",
      }),
    );
  }

  throwIfRunAborted();
  let snap = await snapshot(target);
  throwIfRunAborted();
  const { desired, providerReports } = await runProviderPipeline(config, snap);

  throwIfRunAborted();
  const vendorsCreated = await ensureVendors(target, desired, snap);
  if (vendorsCreated > 0) {
    snap = { ...snap, vendors: await target.listVendors() };
  }

  throwIfRunAborted();
  const diff = buildSyncDiff(config, desired, snap);
  const apply = await applySyncDiff(target, diff);

  if (apply.options.updated.length > 0) {
    await target.updateCache();
  }

  throwIfRunAborted();
  const postApplyPricing = await target.fetchPricing();
  await updateGuestTokenIfConfigured(target, postApplyPricing);

  const successfulProviders = providerReports.filter(
    (provider) => provider.success,
  ).length;
  const hasProviderSuccess =
    successfulProviders > 0 || config.providers.length === 0;
  const elapsedMs = Date.now() - start;
  const success = hasProviderSuccess && apply.errors.length === 0;

  recordRunSummary({ providerReports, apply, diff, elapsedMs, success });
  writeTestReport();

  return {
    success,
    providerReports,
    desired,
    diff,
    apply,
    elapsedMs,
  };
}

function buildChannelProviderMap(result: SyncRunResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const op of result.diff.channels) {
    const channel = op.type === "delete" ? op.existing : op.value;
    if (channel.tag) map.set(channel.name, channel.tag);
  }
  return map;
}

function buildModelProviderMap(result: SyncRunResult): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  const desiredChannels = result.desired.channels;
  for (const channel of desiredChannels) {
    if (!channel.tag) continue;
    if (!channel.models) continue;
    for (const raw of channel.models.split(",")) {
      const name = raw.trim();
      if (!name) continue;
      let bucket = map.get(name);
      if (!bucket) {
        bucket = new Set<string>();
        map.set(name, bucket);
      }
      bucket.add(channel.tag);
    }
  }
  for (const op of result.diff.models) {
    if (op.type !== "delete") continue;
    if (map.has(op.key)) continue;
    map.set(op.key, new Set<string>());
  }
  return new Map(
    Array.from(map.entries()).map(([k, v]) => [k, Array.from(v).sort()]),
  );
}

function annotate(items: string[], lookup: (key: string) => string): string[] {
  return items.map((key) => {
    const tag = lookup(key);
    return tag ? `${key} [${tag}]` : key;
  });
}

export function printRunSummary(result: SyncRunResult): void {
  const elapsed = (result.elapsedMs / 1000).toFixed(2);
  consola.info(
    t("CLI.SUMMARY.PROVIDERS", {
      passed: result.providerReports.filter((provider) => provider.success)
        .length,
      total: result.providerReports.length,
    }),
  );
  const channelProviders = buildChannelProviderMap(result);
  const modelProviders = buildModelProviderMap(result);
  const channelLookup = (name: string) => channelProviders.get(name) ?? "";
  const modelLookup = (name: string) => {
    const tags = modelProviders.get(name);
    return tags && tags.length > 0 ? tags.join(", ") : "";
  };

  consola.info(
    t("CLI.SUMMARY.CHANNELS", {
      created: result.apply.channels.created.length,
      updated: result.apply.channels.updated.length,
      deleted: result.apply.channels.deleted.length,
    }),
  );
  const channelsAdded = annotate(result.apply.channels.created, channelLookup);
  if (channelsAdded.length > 0) {
    consola.info(
      t("CLI.SUMMARY.CHANNELS_ADDED", { items: channelsAdded.join(", ") }),
    );
  }
  const channelsUpdated = annotate(result.apply.channels.updated, channelLookup);
  if (channelsUpdated.length > 0) {
    consola.info(
      t("CLI.SUMMARY.CHANNELS_UPDATED", { items: channelsUpdated.join(", ") }),
    );
  }
  const channelsDeleted = annotate(result.apply.channels.deleted, channelLookup);
  if (channelsDeleted.length > 0) {
    consola.info(
      t("CLI.SUMMARY.CHANNELS_DELETED", { items: channelsDeleted.join(", ") }),
    );
  }
  consola.info(
    t("CLI.SUMMARY.MODELS", {
      created: result.apply.models.created.length,
      updated: result.apply.models.updated.length,
      deleted: result.apply.models.deleted.length,
      orphans: result.apply.models.orphansDeleted,
    }),
  );
  const modelsAdded = annotate(result.apply.models.created, modelLookup);
  if (modelsAdded.length > 0) {
    consola.info(
      t("CLI.SUMMARY.MODELS_ADDED", { items: modelsAdded.join(", ") }),
    );
  }
  const modelsUpdated = annotate(result.apply.models.updated, modelLookup);
  if (modelsUpdated.length > 0) {
    consola.info(
      t("CLI.SUMMARY.MODELS_UPDATED", { items: modelsUpdated.join(", ") }),
    );
  }
  const modelsDeleted = annotate(result.apply.models.deleted, modelLookup);
  if (modelsDeleted.length > 0) {
    consola.info(
      t("CLI.SUMMARY.MODELS_DELETED", { items: modelsDeleted.join(", ") }),
    );
  }
  consola.info(
    t("CLI.SUMMARY.OPTIONS_UPDATED", {
      count: result.apply.options.updated.length,
    }),
  );
  if (result.apply.options.updated.length > 0) {
    consola.info(
      t("CLI.SUMMARY.OPTIONS_UPDATED_LIST", {
        items: result.apply.options.updated.join(", "),
      }),
    );
  }

  for (const provider of result.providerReports) {
    if (provider.success) continue;
    consola.warn(
      t("CLI.SUMMARY.PROVIDER_ERROR", {
        name: provider.name,
        error: provider.error ?? t("CLI.ERROR.UNKNOWN_SHORT"),
      }),
    );
  }

  for (const error of result.apply.errors) {
    consola.error(
      t("CLI.SUMMARY.APPLY_ERROR", {
        phase: error.phase,
        key: error.key,
        message: error.message,
      }),
    );
  }

  if (result.success) {
    consola.success(t("CLI.SUMMARY.COMPLETED", { elapsed }));
  } else {
    consola.error(t("CLI.SUMMARY.COMPLETED_WITH_ERRORS", { elapsed }));
  }
}

export function printResetSummary(result: ResetResult): void {
  consola.info(
    t("CLI.SUMMARY.RESET_COMPLETE", {
      channels: result.channelsDeleted,
      channelsUpdated: result.channelsUpdated,
      models: result.modelsDeleted,
      orphans: result.orphanModelsDeleted,
      tokens: result.tokensDeleted,
      options: result.optionsUpdated.length,
    }),
  );
}
