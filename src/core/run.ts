import type { RuntimeConfig } from "@/config";
import { applySyncDiff } from "@/core/apply";
import { buildSyncDiff } from "@/core/diff";
import { runProviderPipeline } from "@/core/pipeline";
import type { ResetResult } from "@/core/reset";
import { MANAGED_OPTION_KEYS } from "@/lib/constants";
import type { SyncRunResult, TargetSnapshot } from "@/lib/types";
import { NewApiClient } from "@/providers/newapi/client";
import { consola } from "consola";

export interface RunSyncOptions {
  dryRun?: boolean;
}

async function snapshot(client: NewApiClient): Promise<TargetSnapshot> {
  const [channels, models, vendors, options] = await Promise.all([
    client.listChannels(),
    client.listModels(),
    client.listVendors(),
    client.getOptions([...MANAGED_OPTION_KEYS])
  ]);
  return { channels, models, vendors, options };
}

export async function runSync(
  config: RuntimeConfig,
  options: RunSyncOptions = {}
): Promise<SyncRunResult> {
  const start = Date.now();
  const dryRun = options.dryRun ?? false;
  const target = new NewApiClient(config.target, "target");

  const health = await target.healthCheck();
  if (!health.ok) {
    throw new Error(`Target health check failed: ${health.error ?? "unknown"}`);
  }

  const { desired, providerReports } = await runProviderPipeline(
    config,
    target
  );
  const snap = await snapshot(target);
  const diff = buildSyncDiff(config, desired, snap);
  const apply = await applySyncDiff(target, diff, dryRun);

  const successfulProviders = providerReports.filter(
    (provider) => provider.success
  ).length;
  const hasProviderSuccess =
    successfulProviders > 0 || config.providers.length === 0;

  return {
    success: hasProviderSuccess && apply.errors.length === 0,
    providerReports,
    desired,
    diff,
    apply,
    elapsedMs: Date.now() - start
  };
}

export function printRunSummary(result: SyncRunResult): void {
  const elapsed = (result.elapsedMs / 1000).toFixed(2);
  const mode = result.apply.dryRun ? "dry-run" : "apply";
  consola.info(`Mode: ${mode}`);
  consola.info(
    `Providers: ${result.providerReports.filter((provider) => provider.success).length}/${result.providerReports.length}`
  );
  consola.info(
    `Channels: +${result.apply.channels.created} ~${result.apply.channels.updated} -${result.apply.channels.deleted}`
  );
  consola.info(
    `Models: +${result.apply.models.created} ~${result.apply.models.updated} -${result.apply.models.deleted} | Orphans: -${result.apply.models.orphansDeleted}`
  );
  consola.info(`Options updated: ${result.apply.options.updated.length}`);

  for (const provider of result.providerReports) {
    if (provider.success) continue;
    consola.warn(`[${provider.name}] ${provider.error ?? "unknown error"}`);
  }

  for (const error of result.apply.errors) {
    consola.error(`[${error.phase}/${error.key}] ${error.message}`);
  }

  if (result.success) {
    consola.success(`Completed in ${elapsed}s`);
  } else {
    consola.error(`Completed with errors in ${elapsed}s`);
  }
}

export function printResetSummary(result: ResetResult): void {
  consola.info(
    `Reset complete | Channels: -${result.channelsDeleted} | Models: -${result.modelsDeleted} | Orphans: -${result.orphanModelsDeleted} | Tokens: -${result.tokensDeleted} | Options: ${result.optionsUpdated.length}`
  );
}
