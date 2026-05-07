import { applyModelFilter, applyOnlyProviders, loadConfig } from "@core/config";
import { runImageProbe } from "@core/probes/images";
import { runReset } from "@core/sync/reset";
import { printResetSummary, printRunSummary, runSync } from "@core/sync/run";
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
  .option(
    "--models <globs>",
    t("CLI.OPTION.ONLY_MODELS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("-v, --verbose", t("CLI.OPTION.VERBOSE"))
  .action(
    async (options: {
      config?: string;
      only: string[];
      models: string[];
      verbose?: boolean;
    }) => {
      if (options.verbose) consola.level = 4;
      const config = applyModelFilter(
        applyOnlyProviders(await loadConfig(options.config), options.only),
        options.models,
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
  .option(
    "--models <globs>",
    t("CLI.OPTION.ONLY_MODELS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .action(
    async (options: { config?: string; only: string[]; models: string[] }) => {
      const config = applyModelFilter(
        applyOnlyProviders(await loadConfig(options.config), options.only),
        options.models,
      );
      const result = await runReset(config, {
        onlyProviders: options.only.length > 0,
      });
      printResetSummary(result);
    },
  );

program
  .command("images")
  .description(t("CLI.COMMAND.IMAGES_DESC"))
  .option("-c, --config <path>", t("CLI.OPTION.CONFIG_PATH"))
  .option(
    "--only <providers>",
    t("CLI.OPTION.ONLY_PROVIDERS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option(
    "--models <globs>",
    t("CLI.OPTION.ONLY_MODELS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("--dry-run", t("CLI.OPTION.IMAGES_DRY_RUN"))
  .option("--yes", t("CLI.OPTION.IMAGES_YES"))
  .option(
    "--concurrency <n>",
    t("CLI.OPTION.IMAGES_CONCURRENCY"),
    "2",
  )
  .option("-v, --verbose", t("CLI.OPTION.VERBOSE"))
  .action(
    async (options: {
      config?: string;
      only: string[];
      models: string[];
      dryRun?: boolean;
      yes?: boolean;
      concurrency: string;
      verbose?: boolean;
    }) => {
      if (options.verbose) consola.level = 4;
      const config = applyModelFilter(
        applyOnlyProviders(await loadConfig(options.config), options.only),
        options.models,
      );
      const concurrency = Math.max(1, parseInt(options.concurrency, 10) || 2);
      await runImageProbe({
        config,
        dryRun: options.dryRun,
        yes: options.yes,
        concurrency,
      });
    },
  );

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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
