import { applyOnlyProviders, loadConfig } from "@/config";
import { runReset } from "@/core/reset";
import { printResetSummary, printRunSummary, runSync } from "@/core/run";
import { Command } from "commander";

function collectOnly(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function loadRuntimeConfig(configPath: string | undefined, only: string[]) {
  const config = await loadConfig(configPath);
  return applyOnlyProviders(config, only);
}

const program = new Command();
program
  .name("sync")
  .description("new-api-sync")
  .showHelpAfterError();

program
  .command("run")
  .description("run sync pipeline")
  .option("-c, --config <path>", "config file path")
  .option("--only <providers>", "comma-separated provider names", collectOnly, [])
  .option("--dry-run", "compute and print diff only")
  .option("--json", "print JSON output")
  .action(async (options: { config?: string; only: string[]; dryRun?: boolean; json?: boolean }) => {
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
  });

program
  .command("reset")
  .description("delete sync-managed resources")
  .option("-c, --config <path>", "config file path")
  .option("--only <providers>", "comma-separated provider names", collectOnly, [])
  .option("--json", "print JSON output")
  .action(async (options: { config?: string; only: string[]; json?: boolean }) => {
    const config = await loadRuntimeConfig(options.config, options.only);
    const result = await runReset(config);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printResetSummary(result);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
