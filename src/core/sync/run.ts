import { throwIfRunAborted } from "@core/abort";
import type { RuntimeConfig } from "@core/config";
import { applySyncDiff } from "@core/sync/apply";
import { buildSyncDiff } from "@core/sync/diff";
import { runProviderPipeline } from "@core/sync/pipeline";
import type { ResetResult } from "@core/sync/reset";
import { MANAGED_OPTION_KEYS, VENDOR_MATCHERS } from "@core/models/constants";
import { loadKiroBlacklist, writeTestReport } from "@core/models/tester";
import type { DesiredState, SyncRunResult, TargetSnapshot } from "@core/types";
import { NewApiClient } from "@core/providers/newapi/client";
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
  for (const [canonical, matcher] of Object.entries(VENDOR_MATCHERS)) {
    // Direct name match
    const direct = snap.vendors.find(
      (v) =>
        v.name.toLowerCase() === canonical ||
        v.name.toLowerCase() === matcher.displayName?.toLowerCase(),
    );
    if (direct) {
      existingByCanonical.set(canonical, direct);
      continue;
    }
    // Alias match
    for (const alias of matcher.nameAliases ?? []) {
      const match = snap.vendors.find((v) =>
        v.name.toLowerCase().includes(alias.toLowerCase()),
      );
      if (match) {
        existingByCanonical.set(canonical, match);
        break;
      }
    }
  }

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
            `Updated vendor "${displayName}" (id=${existing.id}, icon=${icon ?? "none"})`,
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
        `Created vendor "${displayName}" (id=${result.id}, icon=${icon ?? "none"})`,
      );
      changed++;
    } else {
      consola.warn(`Failed to create vendor "${displayName}"`);
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
  loadKiroBlacklist();

  const health = await target.healthCheck();
  if (!health.ok) {
    throw new Error(`Target health check failed: ${health.error ?? "unknown"}`);
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
    `Providers: ${result.providerReports.filter((provider) => provider.success).length}/${result.providerReports.length}`,
  );
  consola.info(
    `Channels: +${result.apply.channels.created} ~${result.apply.channels.updated} -${result.apply.channels.deleted}`,
  );
  consola.info(
    `Models: +${result.apply.models.created} ~${result.apply.models.updated} -${result.apply.models.deleted} | Orphans: -${result.apply.models.orphansDeleted}`,
  );
  consola.info(`Options updated: ${result.apply.options.updated.length}`);

  for (const provider of result.providerReports) {
    if (provider.success) continue;
    consola.warn(`[${provider.name}] ${provider.error ?? "unknown error"}`);
  }

  for (const error of result.apply.errors) {
    consola.error(`[${error.phase}/${error.key}] ${error.message}`);
  }

  writeTestReport();

  if (result.success) {
    consola.success(`Completed in ${elapsed}s`);
  } else {
    consola.error(`Completed with errors in ${elapsed}s`);
  }
}

export function printResetSummary(result: ResetResult): void {
  consola.info(
    `Reset complete | Channels: -${result.channelsDeleted} | Models: -${result.modelsDeleted} | Orphans: -${result.orphanModelsDeleted} | Tokens: -${result.tokensDeleted} | Options: ${result.optionsUpdated.length}`,
  );
}
