import type { RuntimeConfig } from "@/config";
import {
  CHANNEL_TYPES,
  isTestableModel,
  matchesAnyPattern,
  matchesBlacklist,
  SUB2API_PLATFORM_CHANNEL_TYPES,
  SUB2API_PLATFORM_TO_VENDOR,
  VENDOR_TO_SUB2API_PLATFORMS,
} from "@/lib/constants";
import { ModelTester } from "@/lib/model-tester";
import { buildPriceTiers, pushTieredChannels } from "@/lib/pricing";
import type {
  ProviderReport,
  Sub2ApiProviderConfig,
  SyncState,
} from "@/lib/types";
import { consola } from "consola";
import { Sub2ApiClient } from "./client";

interface ResolvedGroup {
  name: string;
  platform: string;
  apiKey: string;
  models: Set<string>;
}

function filterModels(
  modelIds: string[],
  config: RuntimeConfig,
  providerConfig: Sub2ApiProviderConfig,
): string[] {
  return modelIds.filter((id) => {
    if (matchesBlacklist(id, config.blacklist, providerConfig.name))
      return false;
    if (providerConfig.enabledModels?.length) {
      if (!matchesAnyPattern(id, providerConfig.enabledModels)) return false;
    }
    return true;
  });
}

async function resolveViaAdmin(
  client: Sub2ApiClient,
  providerConfig: Sub2ApiProviderConfig,
  config: RuntimeConfig,
): Promise<ResolvedGroup[]> {
  // Fetch all active groups, filtered by enabledVendors
  const allGroups = await client.listGroups();
  let activeGroups = allGroups.filter((g) => g.status === "active");

  if (providerConfig.enabledVendors?.length) {
    const enabledPlatforms = new Set(
      providerConfig.enabledVendors.flatMap(
        (v) =>
          VENDOR_TO_SUB2API_PLATFORMS[v.toLowerCase()] ?? [v.toLowerCase()],
      ),
    );
    activeGroups = activeGroups.filter((g) =>
      enabledPlatforms.has(g.platform.toLowerCase()),
    );
  }

  if (activeGroups.length === 0) return [];

  // Resolve API key for each group
  const groupKeys = new Map<
    number,
    { name: string; platform: string; apiKey: string }
  >();
  for (const group of activeGroups) {
    const apiKey = await client.getGroupApiKey(group.id);
    if (!apiKey) {
      consola.warn(
        `[${providerConfig.name}] No API key for group "${group.name}", skipping`,
      );
      continue;
    }
    groupKeys.set(group.id, {
      name: group.name,
      platform: group.platform.toLowerCase(),
      apiKey,
    });
  }

  if (groupKeys.size === 0) return [];
  consola.info(
    `[${providerConfig.name}] ${groupKeys.size} groups with API keys`,
  );

  // Fetch models from all active accounts, grouped by platform
  const accounts = await client.listAccounts();
  const activeAccounts = accounts.filter((a) => a.status === "active");
  consola.info(
    `[${providerConfig.name}] ${activeAccounts.length}/${accounts.length} active accounts`,
  );

  const platformModels = new Map<string, Set<string>>();
  for (const account of activeAccounts) {
    const platform = account.platform.toLowerCase();
    if (!platformModels.has(platform)) platformModels.set(platform, new Set());
    const accountModels = await client.getAccountModels(account.id);
    for (const id of filterModels(
      accountModels.map((m) => m.id.replace(/^models\//, "")),
      config,
      providerConfig,
    )) {
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
  config: RuntimeConfig,
): Promise<ResolvedGroup[]> {
  const groups = providerConfig.groups ?? [];
  if (groups.length === 0) return [];

  const resolved: ResolvedGroup[] = [];
  for (const group of groups) {
    const platform = group.platform.toLowerCase();

    // Filter by enabledVendors if specified
    if (providerConfig.enabledVendors?.length) {
      const enabledPlatforms = new Set(
        providerConfig.enabledVendors.flatMap(
          (v) =>
            VENDOR_TO_SUB2API_PLATFORMS[v.toLowerCase()] ?? [v.toLowerCase()],
        ),
      );
      if (!enabledPlatforms.has(platform)) continue;
    }

    const modelIds = await client.listGatewayModels(group.key, platform);
    const filtered = filterModels(modelIds, config, providerConfig);
    if (filtered.length === 0) {
      consola.warn(
        `[${providerConfig.name}] No models for group "${group.name ?? platform}"`,
      );
      continue;
    }

    resolved.push({
      name: group.name ?? platform,
      platform,
      apiKey: group.key,
      models: new Set(filtered),
    });
  }

  consola.info(
    `[${providerConfig.name}] ${resolved.length} groups with models`,
  );
  return resolved;
}

export async function processSub2ApiProvider(
  providerConfig: Sub2ApiProviderConfig,
  config: RuntimeConfig,
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

    // Process each group: test models via group API key, create channel with working models
    const defaultAdjustment = -0.1;
    let totalModels = 0;
    let groupsProcessed = 0;

    for (const groupInfo of resolvedGroups) {
      const vendor =
        SUB2API_PLATFORM_TO_VENDOR[groupInfo.platform] ?? groupInfo.platform;
      const adj = providerConfig.priceAdjustment;
      const adjustment =
        adj === undefined
          ? defaultAdjustment
          : typeof adj === "number"
            ? adj
            : (adj[vendor.toLowerCase()] ?? adj["default"] ?? 0);
      const channelType =
        SUB2API_PLATFORM_CHANNEL_TYPES[groupInfo.platform.toLowerCase()] ??
        CHANNEL_TYPES.OPENAI;
      const useResponsesAPI = groupInfo.platform === "openai";
      const tester = new ModelTester(providerConfig.baseUrl, groupInfo.apiKey);

      // Partition into testable (text endpoints) and non-testable (image-only, etc.)
      const allGroupModels = [...groupInfo.models];
      const testableModels = allGroupModels.filter((id) => isTestableModel(id));
      const nonTestableModels = allGroupModels.filter(
        (id) => !isTestableModel(id),
      );

      let testedWorkingModels: string[] = [];

      if (testableModels.length > 0) {
        const testResult = await tester.testModels(
          testableModels,
          channelType,
          useResponsesAPI,
        );
        testedWorkingModels = testResult.workingModels;
      }

      // Combine tested working models with non-testable models
      const workingModels = [...testedWorkingModels, ...nonTestableModels];

      if (workingModels.length === 0) {
        consola.warn(
          `[${providerConfig.name}] No working models for group "${groupInfo.name}" (0/${testableModels.length} passed)`,
        );
        continue;
      }

      consola.info(
        `[${providerConfig.name}/${groupInfo.platform}] ${workingModels.length}/${groupInfo.models.size} working`,
      );

      if (nonTestableModels.length > 0) {
        consola.info(
          `[${providerConfig.name}/${groupInfo.platform}] Included without test: ${nonTestableModels.join(", ")}`,
        );
      }

      const mappedModels = workingModels.map(
        (m) => config.modelMapping?.[m] ?? m,
      );

      const ratioToModels = buildPriceTiers(
        mappedModels,
        adjustment,
        state,
        providerConfig.name,
      );
      pushTieredChannels(
        ratioToModels,
        `${groupInfo.name}-${providerConfig.name}`,
        {
          type: channelType,
          key: groupInfo.apiKey,
          baseUrl: providerConfig.baseUrl,
          provider: providerConfig.name,
          description: `${groupInfo.platform} via ${providerConfig.name}`,
        },
        state,
      );

      totalModels += mappedModels.length;
      groupsProcessed++;
      const ratios = [...ratioToModels.keys()]
        .map((r) => r.toFixed(4))
        .join(", ");
      consola.info(
        `[${providerConfig.name}/${groupInfo.platform}] ${mappedModels.length} models, ${ratioToModels.size} tier(s): ${ratios} (${(adjustment * 100).toFixed(0)}% adjustment)`,
      );
    }

    providerReport.groups = groupsProcessed;
    providerReport.models = totalModels;
    providerReport.success = groupsProcessed > 0;
    if (!providerReport.success) {
      providerReport.error = "No groups produced working channels";
    }
  } catch (error) {
    providerReport.error =
      error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
