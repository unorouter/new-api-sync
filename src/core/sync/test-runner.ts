import { type RuntimeConfig } from "@core/config";
import {
  initTestReportForDate,
  writeTestReportForDate,
} from "@core/models/tester";
import { runProviderPipeline } from "@core/sync/pipeline";
import { t } from "@server/i18n";
import { consola } from "consola";

const ALL_MODEL_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "embedding",
] as const;

export async function runTestPipeline(config: RuntimeConfig): Promise<boolean> {
  const start = Date.now();

  // Load today's passing results so already-tested models get skipped
  initTestReportForDate();

  // Force all model types, remove sync-specific filters, bypass ratio gate — test everything
  const testConfig: RuntimeConfig = {
    ...config,
    isTestMode: true,
    providers: config.providers.map((p) => ({
      ...p,
      testModelTypes: [...ALL_MODEL_TYPES],
      enabledVendors: undefined,
      enabledModels: undefined,
    })),
  };

  const { providerReports } = await runProviderPipeline(testConfig);

  const succeeded = providerReports.filter((r) => r.success).length;
  consola.info(
    t("CLI.SUMMARY.PROVIDERS", {
      passed: succeeded,
      total: providerReports.length,
    }),
  );
  for (const r of providerReports) {
    const status = r.success
      ? t("CLI.SUMMARY.TEST_STATUS_PASS")
      : t("CLI.SUMMARY.TEST_STATUS_FAIL");
    consola.info(
      t("CLI.SUMMARY.TEST_PROVIDER", {
        status,
        name: r.name,
        models: r.models,
      }),
    );
    if (!r.success && r.error) {
      consola.warn(t("CLI.SUMMARY.TEST_PROVIDER_ERROR", { error: r.error }));
    }
  }

  writeTestReportForDate();

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  if (succeeded > 0) {
    consola.success(t("CLI.SUMMARY.TEST_COMPLETED", { elapsed }));
  } else {
    consola.error(t("CLI.SUMMARY.TEST_COMPLETED_WITH_ERRORS", { elapsed }));
  }
  return succeeded > 0;
}
