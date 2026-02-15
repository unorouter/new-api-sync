import {
  applyModelMapping,
  calculatePriorityBonus,
  isTextModel,
  matchesAnyPattern,
  matchesBlacklist,
  VENDOR_REGISTRY,
} from "@/lib/constants";
import type {
  Config,
  DirectProviderConfig,
  ProviderReport,
  SyncState,
} from "@/lib/types";
import { ModelTester } from "@/service/model-tester";
import { consola } from "consola";
import { DirectApiClient } from "./client";

export async function processDirectProvider(
  providerConfig: DirectProviderConfig,
  config: Config,
  state: SyncState,
): Promise<ProviderReport> {
  const providerReport: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };

  try {
    const vendor = providerConfig.vendor.toLowerCase();
    const vendorInfo = VENDOR_REGISTRY[vendor];
    if (!vendorInfo) throw new Error(`Unknown vendor: ${providerConfig.vendor}`);

    const baseUrl = (providerConfig.baseUrl ?? vendorInfo.defaultBaseUrl).replace(/\/$/, "");
    const client = new DirectApiClient(baseUrl, providerConfig.apiKey, vendorInfo);

    // Discover models from vendor API
    const allModels = await client.discoverModels();
    consola.info(`[${providerConfig.name}] Discovered ${allModels.length} models from ${vendor}`);

    // Filter: text models, blacklist, enabledModels patterns
    const filteredModels = allModels.filter((id) => {
      if (!isTextModel(id)) return false;
      if (matchesBlacklist(id, config.blacklist)) return false;
      if (providerConfig.enabledModels?.length) {
        if (!matchesAnyPattern(id, providerConfig.enabledModels)) return false;
      }
      return true;
    });

    if (filteredModels.length === 0) {
      providerReport.error = "No models passed filters";
      return providerReport;
    }

    consola.info(`[${providerConfig.name}] ${filteredModels.length} models after filtering`);

    // Test models
    const useResponsesAPI = vendor === "openai";
    const tester = new ModelTester(baseUrl, providerConfig.apiKey);
    const testResult = await tester.testModels(filteredModels, vendorInfo.channelType, useResponsesAPI);

    if (testResult.workingModels.length === 0) {
      providerReport.error = `No working models (0/${filteredModels.length} passed)`;
      return providerReport;
    }

    const dynamicPriority = calculatePriorityBonus(testResult.avgResponseTime);
    const dynamicWeight = dynamicPriority > 0 ? dynamicPriority : 1;
    const msStr = testResult.avgResponseTime ? `${Math.round(testResult.avgResponseTime)}ms` : "N/A";

    consola.info(
      `[${providerConfig.name}] ${testResult.workingModels.length}/${filteredModels.length} working | ${msStr} → +${dynamicPriority}`,
    );

    const mappedModels = testResult.workingModels.map((m) =>
      applyModelMapping(m, config.modelMapping),
    );

    const groupRatio = providerConfig.groupRatio ?? 1;
    const channelName = `${vendor}-${providerConfig.name}`;

    state.mergedGroups.push({
      name: channelName,
      ratio: groupRatio,
      description: `${vendor} via ${providerConfig.name} (direct)`,
      provider: providerConfig.name,
    });

    state.channelsToCreate.push({
      name: channelName,
      type: vendorInfo.channelType,
      key: providerConfig.apiKey,
      baseUrl,
      models: mappedModels,
      group: channelName,
      priority: dynamicPriority,
      weight: dynamicWeight,
      provider: providerConfig.name,
      remark: channelName,
    });

    // Add model ratios only if not already set by earlier providers
    for (const model of mappedModels) {
      if (!state.mergedModels.has(model)) {
        state.mergedModels.set(model, { ratio: 1, completionRatio: 1 });
      }
    }

    providerReport.groups = 1;
    providerReport.models = testResult.workingModels.length;
    providerReport.success = true;
  } catch (error) {
    providerReport.error = error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
