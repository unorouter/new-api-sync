import { type RuntimeConfig } from "@core/config";
import { runProviderPipeline } from "@core/pipeline";
import { initTestReportForDate, writeTestReportForDate } from "@core/lib/model-tester";
import { consola } from "consola";

const ALL_MODEL_TYPES = ["text", "image", "video", "audio", "embedding"] as const;

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
  consola.info(`Providers: ${succeeded}/${providerReports.length}`);
  for (const r of providerReports) {
    const status = r.success ? "✓" : "✗";
    consola.info(`  ${status} ${r.name}: ${r.models} models`);
    if (!r.success && r.error) consola.warn(`    ${r.error}`);
  }

  writeTestReportForDate();

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  if (succeeded > 0) {
    consola.success(`Test completed in ${elapsed}s`);
  } else {
    consola.error(`Test completed with errors in ${elapsed}s`);
  }
  return succeeded > 0;
}
