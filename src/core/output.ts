import type { SyncRunResult } from "@/core/types";
import type { ResetResult } from "@/core/reset";
import { consola } from "consola";

export function printRunSummary(result: SyncRunResult): void {
  const elapsed = (result.elapsedMs / 1000).toFixed(2);
  const mode = result.apply.dryRun ? "dry-run" : "apply";
  consola.info(`Mode: ${mode}`);
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
