import { Sub2ApiClient } from "@/clients/sub2api-client";
import {
  applyModelMapping,
  CHANNEL_TYPES,
  isTextModel,
  matchesAnyPattern,
  matchesBlacklist,
} from "@/lib/constants";
import type {
  Config,
  ProviderReport,
  Sub2ApiProviderConfig,
  SyncReport,
} from "@/lib/types";
import { consola } from "consola";
import type { SyncState } from "./types";

function platformToChannelType(platform: string): number {
  switch (platform.toLowerCase()) {
    case "anthropic":
      return CHANNEL_TYPES.ANTHROPIC;
    case "gemini":
      return CHANNEL_TYPES.GEMINI;
    default:
      return CHANNEL_TYPES.OPENAI;
  }
}

export async function processSub2ApiProvider(
  providerConfig: Sub2ApiProviderConfig,
  config: Config,
  state: SyncState,
  report: SyncReport,
): Promise<ProviderReport> {
  const providerReport: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };

  try {
    const client = new Sub2ApiClient(providerConfig);
    const discount = providerConfig.priceDiscount ?? 0.1;
    const groupName = providerConfig.groupName ?? "sub2api";

    // Fetch all accounts and filter by active status
    const accounts = await client.listAccounts();
    const activeAccounts = accounts.filter((a) => a.status === "active");
    consola.info(
      `[${providerConfig.name}] ${activeAccounts.length}/${accounts.length} active accounts`,
    );

    if (activeAccounts.length === 0) {
      providerReport.error = "No active accounts";
      return providerReport;
    }

    // Collect models per platform from all active accounts
    const platformModels = new Map<string, Set<string>>();
    const testedAccountIds = new Set<number>();

    for (const account of activeAccounts) {
      // Filter by enabled vendors if specified
      if (providerConfig.enabledVendors?.length) {
        const vendorSet = new Set(providerConfig.enabledVendors.map((v) => v.toLowerCase()));
        const accountVendor = account.platform.toLowerCase();
        // Map sub2api platform names to vendor names
        const vendorName =
          accountVendor === "gemini" ? "google" : accountVendor;
        if (!vendorSet.has(vendorName) && !vendorSet.has(accountVendor)) continue;
      }

      // Test account health
      consola.info(`[${providerConfig.name}] Testing account ${account.id} (${account.platform}/${account.name})...`);
      const healthy = await client.testAccount(account.id);
      if (!healthy) {
        consola.warn(`[${providerConfig.name}] Account ${account.id} (${account.name}) failed test, skipping`);
        continue;
      }
      testedAccountIds.add(account.id);

      // Get models for this account
      const models = await client.getAccountModels(account.id);
      const platform = account.platform.toLowerCase();

      if (!platformModels.has(platform)) {
        platformModels.set(platform, new Set());
      }

      for (const model of models) {
        const modelId = model.id.replace(/^models\//, "");
        if (!isTextModel(modelId)) continue;
        if (matchesBlacklist(modelId, config.blacklist)) continue;

        // Filter by enabled models if specified
        if (providerConfig.enabledModels?.length) {
          if (!matchesAnyPattern(modelId, providerConfig.enabledModels)) continue;
        }

        platformModels.get(platform)!.add(modelId);
      }

      consola.info(
        `[${providerConfig.name}] Account ${account.id} (${account.name}): ${models.length} models, healthy`,
      );
    }

    if (testedAccountIds.size === 0) {
      providerReport.error = "No healthy accounts after testing";
      return providerReport;
    }

    // Create channels per platform
    let totalModels = 0;
    for (const [platform, models] of platformModels) {
      if (models.size === 0) continue;

      const channelType = platformToChannelType(platform);
      const channelName = `${groupName}-${platform}`;

      // Apply model name mapping
      const mappedModels = [...models].map((m) =>
        applyModelMapping(m, config.modelMapping),
      );

      // Determine pricing: undercut existing remote prices by discount %
      const lowestGroupRatio = state.mergedGroups.length > 0
        ? Math.min(...state.mergedGroups.map((g) => g.ratio))
        : 1;
      const groupRatio = lowestGroupRatio * (1 - discount);

      for (const modelName of mappedModels) {
        const existing = state.mergedModels.get(modelName);
        const discountedRatio = existing
          ? existing.ratio * (1 - discount)
          : 1;
        const discountedCompletion = existing
          ? existing.completionRatio * (1 - discount)
          : 1;

        state.mergedModels.set(modelName, {
          ratio: discountedRatio,
          completionRatio: discountedCompletion,
        });
      }

      state.mergedGroups.push({
        name: channelName,
        ratio: groupRatio,
        description: `${platform} via ${providerConfig.name}`,
        provider: providerConfig.name,
      });

      state.channelsToCreate.push({
        name: channelName,
        type: channelType,
        key: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        models: mappedModels,
        group: channelName,
        priority: 100,
        weight: 100,
        provider: providerConfig.name,
        remark: `${providerConfig.name}-${platform}`,
      });

      totalModels += models.size;
      consola.info(
        `[${providerConfig.name}/${platform}] ${models.size} models, ratio: ${groupRatio.toFixed(4)} (${(discount * 100).toFixed(0)}% below remote)`,
      );
    }

    providerReport.groups = platformModels.size;
    providerReport.models = totalModels;
    providerReport.success = true;
  } catch (error) {
    providerReport.error = error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
