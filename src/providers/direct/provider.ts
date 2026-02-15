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

    const channelName = `${vendor}-${providerConfig.name}`;

    // Determine group ratio: explicit groupRatio, or derive from priceAdjustment
    if (providerConfig.priceAdjustment !== undefined) {
      // Build model → cheapest existing group ratio lookup
      const groupRatioByName = new Map(state.mergedGroups.map(g => [g.name, g.ratio]));
      const cheapestGroupForModel = new Map<string, number>();
      for (const ch of state.channelsToCreate) {
        if (ch.provider === providerConfig.name) continue;
        const gRatio = groupRatioByName.get(ch.group) ?? 1;
        for (const model of ch.models) {
          const existing = cheapestGroupForModel.get(model);
          if (existing === undefined || gRatio < existing) {
            cheapestGroupForModel.set(model, gRatio);
          }
        }
      }

      // Group models by their adjusted ratio so each tier gets accurate pricing
      const discount = providerConfig.priceAdjustment;
      const ratioToModels = new Map<number, string[]>();
      for (const model of mappedModels) {
        const cheapest = cheapestGroupForModel.get(model) ?? 1;
        const ratio = cheapest * (1 - discount);
        const key = Math.round(ratio * 1e6) / 1e6;
        if (!ratioToModels.has(key)) ratioToModels.set(key, []);
        ratioToModels.get(key)!.push(model);
      }

      // Create tiered channels if models have different ratios
      let tierIdx = 0;
      for (const [tierRatio, models] of ratioToModels) {
        const suffix = ratioToModels.size > 1 ? `-t${tierIdx}` : "";
        const tierName = `${channelName}${suffix}`;

        state.mergedGroups.push({
          name: tierName,
          ratio: tierRatio,
          description: `${vendor} via ${providerConfig.name} (direct)`,
          provider: providerConfig.name,
        });

        state.channelsToCreate.push({
          name: tierName,
          type: vendorInfo.channelType,
          key: providerConfig.apiKey,
          baseUrl,
          models,
          group: tierName,
          priority: dynamicPriority,
          weight: dynamicWeight,
          provider: providerConfig.name,
          remark: tierName,
        });

        tierIdx++;
      }
    } else {
      const groupRatio = providerConfig.groupRatio ?? 1;
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
    }

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
