import { applyOnlyProviders, loadConfig } from "@/config";
import { runReset } from "@/core/reset";
import { printResetSummary, printRunSummary, runSync } from "@/core/run";
import { Command } from "commander";
import { consola } from "consola";

const program = new Command();
program.name("sync").description("new-api-sync").showHelpAfterError();

program
  .command("run")
  .description("run sync pipeline")
  .option("-c, --config <path>", "config file path")
  .option(
    "--only <providers>",
    "comma-separated provider names",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("-v, --verbose", "enable debug logging")
  .action(async (options: { config?: string; only: string[]; verbose?: boolean }) => {
    if (options.verbose) consola.level = 4;
    const config = applyOnlyProviders(
      await loadConfig(options.config),
      options.only,
    );
    const result = await runSync(config);
    printRunSummary(result);

    if (!result.success) {
      process.exitCode = 1;
    }
  });

program
  .command("reset")
  .description("delete sync-managed resources")
  .option("-c, --config <path>", "config file path")
  .option(
    "--only <providers>",
    "comma-separated provider names",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .action(async (options: { config?: string; only: string[] }) => {
    const config = applyOnlyProviders(
      await loadConfig(options.config),
      options.only,
    );
    const result = await runReset(config);
    printResetSummary(result);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
