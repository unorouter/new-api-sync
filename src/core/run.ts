import type { RuntimeConfig } from "@/config";
import { applySyncDiff } from "@/core/apply";
import { buildSyncDiff } from "@/core/diff";
import { runProviderPipeline } from "@/core/pipeline";
import type { ResetResult } from "@/core/reset";
import { MANAGED_OPTION_KEYS, VENDOR_MATCHERS } from "@/lib/constants";
import { writeTestReport } from "@/lib/model-tester";
import type { DesiredState, SyncRunResult, TargetSnapshot } from "@/lib/types";
import { NewApiClient } from "@/providers/newapi/client";
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

  const existingNames = new Set(snap.vendors.map((v) => v.name.toLowerCase()));
  const existingAliases = new Map<string, boolean>();
  for (const [canonical, matcher] of Object.entries(VENDOR_MATCHERS)) {
    if (existingNames.has(canonical)) {
      existingAliases.set(canonical, true);
      continue;
    }
    for (const alias of matcher.nameAliases ?? []) {
      if (snap.vendors.some((v) => v.name.toLowerCase().includes(alias.toLowerCase()))) {
        existingAliases.set(canonical, true);
        break;
      }
    }
  }

  let created = 0;
  for (const vendor of neededVendors) {
    if (existingNames.has(vendor) || existingAliases.get(vendor)) continue;
    const matcher = VENDOR_MATCHERS[vendor];
    const displayName = matcher?.displayName ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
    const icon = matcher?.icon;
    const result = await client.createVendor({ name: displayName, icon });
    if (result) {
      consola.info(`Created vendor "${displayName}" (id=${result.id}, icon=${icon ?? "none"})`);
      created++;
    } else {
      consola.warn(`Failed to create vendor "${displayName}"`);
    }
  }
  return created;
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

  const health = await target.healthCheck();
  if (!health.ok) {
    throw new Error(`Target health check failed: ${health.error ?? "unknown"}`);
  }

  let snap = await snapshot(target);
  const { desired, providerReports } = await runProviderPipeline(config, snap);

  const vendorsCreated = await ensureVendors(target, desired, snap);
  if (vendorsCreated > 0) {
    snap = { ...snap, vendors: await target.listVendors() };
  }

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
