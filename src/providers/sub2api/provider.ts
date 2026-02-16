import {
  applyModelMapping,
  calculatePriorityBonus,
  CHANNEL_TYPES,
  isTextModel,
  matchesAnyPattern,
  matchesBlacklist,
} from "@/lib/constants";
import { buildPriceTiers, pushTieredChannels } from "@/lib/pricing";
import type {
  Config,
  ProviderReport,
  Sub2ApiProviderConfig,
  SyncState,
} from "@/lib/types";
import { ModelTester } from "@/service/model-tester";
import { consola } from "consola";
import { Sub2ApiClient } from "./client";

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

interface ResolvedGroup {
  name: string;
  platform: string;
  apiKey: string;
  models: Set<string>;
}

function filterModels(
  modelIds: string[],
  config: Config,
  providerConfig: Sub2ApiProviderConfig,
): string[] {
  return modelIds.filter((id) => {
    if (!isTextModel(id)) return false;
    if (matchesBlacklist(id, config.blacklist)) return false;
    if (providerConfig.enabledModels?.length) {
      if (!matchesAnyPattern(id, providerConfig.enabledModels)) return false;
    }
    return true;
  });
}

async function resolveViaAdmin(
  client: Sub2ApiClient,
  providerConfig: Sub2ApiProviderConfig,
  config: Config,
): Promise<ResolvedGroup[]> {
  // Fetch all active groups, filtered by enabledVendors
  const allGroups = await client.listGroups();
  let activeGroups = allGroups.filter((g) => g.status === "active");

  if (providerConfig.enabledVendors?.length) {
    const enabledPlatforms = new Set(
      providerConfig.enabledVendors.flatMap((v) => VENDOR_TO_PLATFORMS[v.toLowerCase()] ?? [v.toLowerCase()]),
    );
    activeGroups = activeGroups.filter((g) => enabledPlatforms.has(g.platform.toLowerCase()));
  }

  if (activeGroups.length === 0) return [];

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

  if (groupKeys.size === 0) return [];
  consola.info(`[${providerConfig.name}] ${groupKeys.size} groups with API keys`);

  // Fetch models from all active accounts, grouped by platform
  const accounts = await client.listAccounts();
  const activeAccounts = accounts.filter((a) => a.status === "active");
  consola.info(`[${providerConfig.name}] ${activeAccounts.length}/${accounts.length} active accounts`);

  const platformModels = new Map<string, Set<string>>();
  for (const account of activeAccounts) {
    const platform = account.platform.toLowerCase();
    if (!platformModels.has(platform)) platformModels.set(platform, new Set());
    const accountModels = await client.getAccountModels(account.id);
    for (const id of filterModels(accountModels.map((m) => m.id.replace(/^models\//, "")), config, providerConfig)) {
      platformModels.get(platform)!.add(id);
    }
  }

  // Combine into resolved groups
  const resolved: ResolvedGroup[] = [];
  for (const [, info] of groupKeys) {
    const models = platformModels.get(info.platform);
    if (!models || models.size === 0) continue;
    resolved.push({ ...info, models });
  }
  return resolved;
}

async function resolveViaGroups(
  client: Sub2ApiClient,
  providerConfig: Sub2ApiProviderConfig,
  config: Config,
): Promise<ResolvedGroup[]> {
  const groups = providerConfig.groups ?? [];
  if (groups.length === 0) return [];

  const resolved: ResolvedGroup[] = [];
  for (const group of groups) {
    const platform = group.platform.toLowerCase();

    // Filter by enabledVendors if specified
    if (providerConfig.enabledVendors?.length) {
      const enabledPlatforms = new Set(
        providerConfig.enabledVendors.flatMap((v) => VENDOR_TO_PLATFORMS[v.toLowerCase()] ?? [v.toLowerCase()]),
      );
      if (!enabledPlatforms.has(platform)) continue;
    }

    const modelIds = await client.listGatewayModels(group.key, platform);
    const filtered = filterModels(modelIds, config, providerConfig);
    if (filtered.length === 0) {
      consola.warn(`[${providerConfig.name}] No models for group "${group.name ?? platform}"`);
      continue;
    }

    resolved.push({
      name: group.name ?? platform,
      platform,
      apiKey: group.key,
      models: new Set(filtered),
    });
  }

  consola.info(`[${providerConfig.name}] ${resolved.length} groups with models`);
  return resolved;
}

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

    // Resolve groups: admin mode or explicit groups mode
    const resolvedGroups = providerConfig.adminApiKey
      ? await resolveViaAdmin(client, providerConfig, config)
      : await resolveViaGroups(client, providerConfig, config);

    if (resolvedGroups.length === 0) {
      providerReport.error = "No groups with models found";
      return providerReport;
    }

    // Build model → cheapest newapi group ratio lookup
    const discount = providerConfig.priceAdjustment ?? 0.1;

    // Process each group: test models via group API key, create channel with working models
    let totalModels = 0;
    let groupsProcessed = 0;

    for (const groupInfo of resolvedGroups) {
      const channelType = platformToChannelType(groupInfo.platform);
      const useResponsesAPI = groupInfo.platform === "openai";
      const tester = new ModelTester(providerConfig.baseUrl, groupInfo.apiKey);
      const testResult = await tester.testModels([...groupInfo.models], channelType, useResponsesAPI);

      if (testResult.workingModels.length === 0) {
        consola.warn(`[${providerConfig.name}] No working models for group "${groupInfo.name}" (0/${groupInfo.models.size} passed)`);
        continue;
      }

      const dynamicPriority = calculatePriorityBonus(testResult.avgResponseTime);
      const dynamicWeight = dynamicPriority > 0 ? dynamicPriority : 1;
      const msStr = testResult.avgResponseTime ? `${Math.round(testResult.avgResponseTime)}ms` : "N/A";

      consola.info(
        `[${providerConfig.name}/${groupInfo.platform}] ${testResult.workingModels.length}/${groupInfo.models.size} | ${msStr} → +${dynamicPriority}`,
      );

      const mappedModels = testResult.workingModels.map((m) =>
        applyModelMapping(m, config.modelMapping),
      );

      const ratioToModels = buildPriceTiers(mappedModels, discount, state, providerConfig.name);
      pushTieredChannels(
        ratioToModels,
        `${groupInfo.name}-${providerConfig.name}`,
        {
          type: channelType,
          key: groupInfo.apiKey,
          baseUrl: providerConfig.baseUrl,
          priority: dynamicPriority,
          weight: dynamicWeight,
          provider: providerConfig.name,
          description: `${groupInfo.platform} via ${providerConfig.name}`,
        },
        state,
      );

      totalModels += testResult.workingModels.length;
      groupsProcessed++;
      const ratios = [...ratioToModels.keys()].map(r => r.toFixed(4)).join(", ");
      consola.info(
        `[${providerConfig.name}/${groupInfo.platform}] ${testResult.workingModels.length} models, ${ratioToModels.size} tier(s): ${ratios} (${(discount * 100).toFixed(0)}% below remote)`,
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
