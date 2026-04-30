import { throwIfRunAborted } from "@core/runtime/abort";
import type { RuntimeConfig } from "@core/config";
import {
  findVendorByAlias,
  forEachVendor,
  VENDOR_MATCHERS,
} from "@core/catalog/constants/vendor-matchers";
import { MANAGED_OPTION_KEYS } from "@core/types";
import { loadAuthenticityBlacklist } from "@core/testing/authenticity";
import { writeTestReport } from "@core/testing/runner";
import { NewApiClient } from "@core/vendors/newapi/client";
import { applySyncDiff } from "@core/sync/apply";
import { buildSyncDiff } from "@core/sync/diff";
import { runProviderPipeline } from "@core/sync/pipeline";
import type { ResetResult } from "@core/sync/reset";
import type { DesiredState, SyncRunResult, TargetSnapshot } from "@core/types";
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

  writeTestReport();

  const successfulProviders = providerReports.filter(
    (provider) => provider.success,
  ).length;
  const hasProviderSuccess =
    successfulProviders > 0 || config.providers.length === 0;

  return {
    success: hasProviderSuccess && apply.errors.length === 0,
    providerReports,
    desired,
    diff,
    apply,
    elapsedMs: Date.now() - start,
  };
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
  consola.info(
    t("CLI.SUMMARY.CHANNELS", {
      created: result.apply.channels.created,
      updated: result.apply.channels.updated,
      deleted: result.apply.channels.deleted,
    }),
  );
  consola.info(
    t("CLI.SUMMARY.MODELS", {
      created: result.apply.models.created,
      updated: result.apply.models.updated,
      deleted: result.apply.models.deleted,
      orphans: result.apply.models.orphansDeleted,
    }),
  );
  consola.info(
    t("CLI.SUMMARY.OPTIONS_UPDATED", {
      count: result.apply.options.updated.length,
    }),
  );

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
