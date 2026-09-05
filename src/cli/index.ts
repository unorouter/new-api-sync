import {
  applyModelFilter,
  applyModelTypeFilter,
  applyOnlyProviders,
  loadConfig,
} from "@core/config";
import { fetchBasellmEntries } from "@core/catalog/metadata";
import { fetchAllPricingSources } from "@core/pricing/resolver";
import { resolveCanonicalByVote } from "@core/pricing/vote";
import { checkBalances, printBalanceSummary } from "@core/sync/balance";
import { printMetadataSummary, runMetadataSync } from "@core/sync/metadata";
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
  .option(
    "--type <types>",
    t("CLI.OPTION.MODEL_TYPES"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("--dry-run", t("CLI.OPTION.DRY_RUN"))
  .option("-v, --verbose", t("CLI.OPTION.VERBOSE"))
  .action(
    async (options: {
      config?: string;
      only: string[];
      models: string[];
      type: string[];
      dryRun?: boolean;
      verbose?: boolean;
    }) => {
      if (options.verbose) consola.level = 4;
      const config = applyModelTypeFilter(
        applyModelFilter(
          applyOnlyProviders(await loadConfig(options.config), options.only),
          options.models,
        ),
        options.type,
      );
      const result = await runSync(config, { dryRun: options.dryRun });
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
  .command("metadata")
  .description(t("CLI.COMMAND.METADATA_DESC"))
  .option("-c, --config <path>", t("CLI.OPTION.CONFIG_PATH"))
  .option(
    "--models <globs>",
    t("CLI.OPTION.ONLY_MODELS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("--dry-run", t("CLI.OPTION.METADATA_DRY_RUN"))
  .option("-v, --verbose", t("CLI.OPTION.VERBOSE"))
  .action(
    async (options: {
      config?: string;
      models: string[];
      dryRun?: boolean;
      verbose?: boolean;
    }) => {
      if (options.verbose) consola.level = 4;
      const config = applyModelFilter(
        await loadConfig(options.config),
        options.models,
      );
      const result = await runMetadataSync(config, { dryRun: options.dryRun });
      printMetadataSummary(result);
      if (result.failed > 0 || result.optionErrors.length > 0)
        process.exitCode = 1;
    },
  );

program
  .command("balance")
  .description(t("CLI.COMMAND.BALANCE_DESC"))
  .option("-c, --config <path>", t("CLI.OPTION.CONFIG_PATH"))
  .option(
    "--only <providers>",
    t("CLI.OPTION.ONLY_PROVIDERS"),
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("--json", t("CLI.OPTION.BALANCE_JSON"))
  .option("-v, --verbose", t("CLI.OPTION.VERBOSE"))
  .action(
    async (options: {
      config?: string;
      only: string[];
      json?: boolean;
      verbose?: boolean;
    }) => {
      if (options.verbose) consola.level = 4;
      if (options.json) consola.level = 0;
      const config = applyOnlyProviders(
        await loadConfig(options.config),
        options.only,
      );
      const result = await checkBalances(config);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else printBalanceSummary(result);
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

program
  .command("baseline")
  .description("Dump every canonical (voted) list price as USD per 1M tokens")
  .option("--out <path>", "output JSON path", "baseline.json")
  .action(async (options: { out: string }) => {
    const sources = await fetchAllPricingSources(await fetchBasellmEntries());
    const names = new Set<string>();
    for (const s of sources)
      for (const k of s.pricing.candidates.keys()) names.add(k);
    const out: Record<
      string,
      { input_usd_per_m: number; output_usd_per_m: number; sources: string[] }
    > = {};
    for (const m of [...names].sort()) {
      const vote = resolveCanonicalByVote(m, sources, new Map());
      if (!vote.cluster) continue;
      out[m] = {
        input_usd_per_m: +(vote.cluster.modelRatio * 2).toFixed(4),
        output_usd_per_m: +(
          vote.cluster.modelRatio *
          2 *
          vote.cluster.completionRatio
        ).toFixed(4),
        sources: vote.cluster.members,
      };
    }
    await Bun.write(
      options.out,
      JSON.stringify(
        { generated_at: new Date().toISOString(), models: out },
        null,
        1,
      ),
    );
    consola.info(
      `baseline: ${Object.keys(out).length} voted of ${names.size} names -> ${options.out}`,
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
