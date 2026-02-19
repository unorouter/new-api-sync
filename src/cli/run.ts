import { loadRuntimeConfig } from "@/cli/helpers";
import { printRunSummary } from "@/core/output";
import { runSync } from "@/core/run";

export interface RunCommandOptions {
  config?: string;
  only: string[];
  dryRun?: boolean;
  json?: boolean;
}

export async function runCommand(options: RunCommandOptions): Promise<void> {
  const config = await loadRuntimeConfig(options.config, options.only);
  const result = await runSync(config, { dryRun: options.dryRun });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: result.success,
          elapsedMs: result.elapsedMs,
          providers: result.providerReports,
          diff: {
            channels: result.diff.channels,
            models: result.diff.models,
            options: result.diff.options,
            cleanupOrphans: result.diff.cleanupOrphans
          },
          apply: result.apply,
          desired: {
            channels: result.desired.channels,
            models: [...result.desired.models.values()],
            options: result.desired.options,
            policy: result.desired.policy,
            managedProviders: [...result.desired.managedProviders],
            mappingSources: [...result.desired.mappingSources]
          }
        },
        null,
        2
      )
    );
  } else {
    printRunSummary(result);
  }

  if (!result.success) {
    process.exitCode = 1;
  }
}
