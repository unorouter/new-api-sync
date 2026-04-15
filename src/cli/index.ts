import { applyOnlyProviders, loadConfig } from "@core/config";
import { runReset } from "@core/sync/reset";
import { printResetSummary, printRunSummary, runSync } from "@core/sync/run";
import { runTestPipeline } from "@core/sync/test-runner";
import { readLocaleFromGlobal, setLocale, t } from "@server/i18n";
import { Command } from "commander";
import { consola } from "consola";

setLocale(await readLocaleFromGlobal());
const program = new Command();
program.name("sync").description(t("CLI.APP_DESCRIPTION")).showHelpAfterError();

program
  .command("run")
  .description(t("CLI.COMMAND.RUN_DESC"))
  .option("-c, --config <path>", t("CLI.OPTION.CONFIG_PATH"))
  .option(
    "--only <providers>",
    t("CLI.OPTION.ONLY_PROVIDERS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("-v, --verbose", t("CLI.OPTION.VERBOSE"))
  .action(
    async (options: { config?: string; only: string[]; verbose?: boolean }) => {
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
    },
  );

program
  .command("reset")
  .description(t("CLI.COMMAND.RESET_DESC"))
  .option("-c, --config <path>", t("CLI.OPTION.CONFIG_PATH"))
  .option(
    "--only <providers>",
    t("CLI.OPTION.ONLY_PROVIDERS"),
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

program
  .command("ui")
  .description(t("CLI.COMMAND.UI_DESC"))
  .option("-p, --port <port>", t("CLI.OPTION.PORT"), "3000")
  .action(async (options: { port: string }) => {
    process.env.PORT = options.port;
    const { app } = await import("@server/route");
    app.listen(Number(options.port));
    consola.success(t("CLI.STATUS.UI_RUNNING", { port: options.port }));
  });

program
  .command("test")
  .description(t("CLI.COMMAND.TEST_DESC"))
  .option("-c, --config <path>", t("CLI.OPTION.CONFIG_PATH"))
  .option(
    "--only <providers>",
    t("CLI.OPTION.ONLY_PROVIDERS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("-v, --verbose", t("CLI.OPTION.VERBOSE"))
  .action(
    async (options: { config?: string; only: string[]; verbose?: boolean }) => {
      if (options.verbose) consola.level = 4;
      const config = applyOnlyProviders(
        await loadConfig(options.config),
        options.only,
      );
      const success = await runTestPipeline(config);
      if (!success) {
        process.exitCode = 1;
      }
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
