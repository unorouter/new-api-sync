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

// Map new-api vendor names → sub2api platform names (one vendor can match multiple platforms)
const VENDOR_TO_PLATFORMS: Record<string, string[]> = {
  google: ["gemini", "antigravity"],
  anthropic: ["anthropic"],
  openai: ["openai"],
};

export async function processSub2ApiProvider(
  providerConfig: Sub2ApiProviderConfig,
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
    const client = new Sub2ApiClient(providerConfig);
    const discount = providerConfig.priceDiscount ?? 0.1;

    // Fetch all active groups, filtered by enabledVendors
    const allGroups = await client.listGroups();
    let activeGroups = allGroups.filter((g) => g.status === "active");

    if (providerConfig.enabledVendors?.length) {
      const enabledPlatforms = new Set(
        providerConfig.enabledVendors.flatMap((v) => VENDOR_TO_PLATFORMS[v.toLowerCase()] ?? [v.toLowerCase()]),
      );
      activeGroups = activeGroups.filter((g) => enabledPlatforms.has(g.platform.toLowerCase()));
    }

    if (activeGroups.length === 0) {
      providerReport.error = "No active groups on sub2api";
      return providerReport;
    }

    // Resolve API key for each group
    const groupKeys = new Map<number, { name: string; platform: string; apiKey: string }>();
    for (const group of activeGroups) {
      const apiKey = await client.getGroupApiKey(group.id);
      if (!apiKey) {
        consola.warn(`[${providerConfig.name}] No API key for group "${group.name}", skipping`);
        continue;
      }
      groupKeys.set(group.id, {
        name: group.name,
        platform: group.platform.toLowerCase(),
        apiKey,
      });
    }

    if (groupKeys.size === 0) {
      providerReport.error = "No groups with active API keys";
      return providerReport;
    }
    consola.info(`[${providerConfig.name}] ${groupKeys.size} groups with API keys`);

    // Fetch all accounts and filter by active status
    const accounts = await client.listAccounts();
    const activeAccounts = accounts.filter((a) => a.status === "active");
    consola.info(
      `[${providerConfig.name}] ${activeAccounts.length}/${accounts.length} active accounts`,
    );

    // Group accounts by platform
    const platformAccounts = new Map<string, typeof activeAccounts>();
    for (const account of activeAccounts) {
      const platform = account.platform.toLowerCase();
      if (!platformAccounts.has(platform)) {
        platformAccounts.set(platform, []);
      }
      platformAccounts.get(platform)!.push(account);
    }

    // Process each group: test its platform's accounts, collect models, create channel
    let totalModels = 0;
    let groupsProcessed = 0;

    for (const [, groupInfo] of groupKeys) {
      const accounts = platformAccounts.get(groupInfo.platform) ?? [];
      if (accounts.length === 0) {
        consola.warn(`[${providerConfig.name}] No ${groupInfo.platform} accounts for group "${groupInfo.name}"`);
        continue;
      }

      // Test accounts and collect models
      const models = new Set<string>();
      let testedCount = 0;

      for (const account of accounts) {
        consola.info(`[${providerConfig.name}] Testing account ${account.id} (${account.name})...`);
        const healthy = await client.testAccount(account.id);
        if (!healthy) {
          consola.warn(`[${providerConfig.name}] Account ${account.id} (${account.name}) failed test, skipping`);
          continue;
        }
        testedCount++;

        const accountModels = await client.getAccountModels(account.id);
        for (const model of accountModels) {
          const modelId = model.id.replace(/^models\//, "");
          if (!isTextModel(modelId)) continue;
          if (matchesBlacklist(modelId, config.blacklist)) continue;
          if (providerConfig.enabledModels?.length) {
            if (!matchesAnyPattern(modelId, providerConfig.enabledModels)) continue;
          }
          models.add(modelId);
        }

        consola.info(
          `[${providerConfig.name}] Account ${account.id} (${account.name}): ${accountModels.length} models, healthy`,
        );
      }

      if (testedCount === 0 || models.size === 0) {
        consola.warn(`[${providerConfig.name}] No working models for group "${groupInfo.name}"`);
        continue;
      }

      // Create channel for this group's platform
      const channelType = platformToChannelType(groupInfo.platform);
      const channelName = `${providerConfig.name}-${groupInfo.platform}`;

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
        description: `${groupInfo.platform} via ${providerConfig.name}`,
        provider: providerConfig.name,
      });

      state.channelsToCreate.push({
        name: channelName,
        type: channelType,
        key: groupInfo.apiKey,
        baseUrl: providerConfig.baseUrl,
        models: mappedModels,
        group: channelName,
        priority: 100,
        weight: 100,
        provider: providerConfig.name,
        remark: `${providerConfig.name}-${groupInfo.platform}`,
      });

      totalModels += models.size;
      groupsProcessed++;
      consola.info(
        `[${providerConfig.name}/${groupInfo.platform}] ${models.size} models, ratio: ${groupRatio.toFixed(4)} (${(discount * 100).toFixed(0)}% below remote)`,
      );
    }

    providerReport.groups = groupsProcessed;
    providerReport.models = totalModels;
    providerReport.success = groupsProcessed > 0;
    if (!providerReport.success) {
      providerReport.error = "No groups produced working channels";
    }
  } catch (error) {
    providerReport.error = error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
