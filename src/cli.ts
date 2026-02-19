import { collectOnly } from "@/cli/helpers";
import { resetCommand } from "@/cli/reset";
import { runCommand } from "@/cli/run";
import { Command } from "commander";

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
  .action(async (options) => {
    await runCommand(options);
  });

program
  .command("reset")
  .description("delete sync-managed resources")
  .option("-c, --config <path>", "config file path")
  .option("--only <providers>", "comma-separated provider names", collectOnly, [])
  .option("--json", "print JSON output")
  .action(async (options) => {
    await resetCommand(options);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
