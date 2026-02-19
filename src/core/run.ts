import type { RuntimeConfig } from "@/config/schema";
import { applySyncDiff } from "@/core/apply";
import { buildSyncDiff } from "@/core/diff";
import { runProviderPipeline } from "@/core/pipeline";
import type { SyncRunResult } from "@/core/types";
import { TargetClient } from "@/target/client";

export interface RunSyncOptions {
  dryRun?: boolean;
}

export async function runSync(
  config: RuntimeConfig,
  options: RunSyncOptions = {},
): Promise<SyncRunResult> {
  const start = Date.now();
  const dryRun = options.dryRun ?? false;
  const target = new TargetClient(config.target);

  const health = await target.healthCheck();
  if (!health.ok) {
    throw new Error(`Target health check failed: ${health.error ?? "unknown"}`);
  }

  const { desired, providerReports } = await runProviderPipeline(config, target);
  const snapshot = await target.snapshot();
  const diff = buildSyncDiff(config, desired, snapshot);
  const apply = await applySyncDiff(target, diff, dryRun);

  const successfulProviders = providerReports.filter((provider) => provider.success).length;
  const hasProviderSuccess = successfulProviders > 0 || config.providers.length === 0;

  return {
    success: hasProviderSuccess && apply.errors.length === 0,
    providerReports,
    desired,
    diff,
    apply,
    elapsedMs: Date.now() - start,
  };
}
