import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import {
  sanitizeGroupName,
  SUB2API_PLATFORM_CHANNEL_TYPES,
  SUB2API_PLATFORM_TO_VENDOR,
  VENDOR_TO_SUB2API_PLATFORMS,
} from "@core/catalog/constants/patterns";
import { filterModels } from "@core/catalog/filter";
import { getTestModelTypes, type RuntimeConfig } from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  UpstreamOffer,
} from "@core/pricing/offers";
import { type PricingSource } from "@core/pricing/resolver";
import { recordProviderCost, testAndFilterModels } from "@core/testing/runner";
import type { ProviderReport } from "@core/types";
import type { Sub2ApiProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildCapabilityMap, lowercaseExposed } from "../shared/capability-map";
import { Sub2ApiClient } from "./client";

interface ResolvedGroup {
  name: string;
  platform: string;
  apiKey: string;
  models: Set<string>;
}

const getEnabledPlatforms = (enabledVendors?: string[]): Set<string> | null =>
  enabledVendors?.length
    ? new Set(
        enabledVendors.flatMap(
          (v) =>
            VENDOR_TO_SUB2API_PLATFORMS[v.toLowerCase()] ?? [v.toLowerCase()],
        ),
      )
    : null;

const sumBalances = (values: (number | null)[]): number | null =>
  values.reduce<number | null>(
    (acc, b) => (b === null ? acc : (acc ?? 0) + b),
    null,
  );

async function resolveViaAdmin(
  client: Sub2ApiClient,
  providerConfig: Sub2ApiProviderConfig,
  config: RuntimeConfig,
): Promise<ResolvedGroup[]> {
  const enabledPlatforms = getEnabledPlatforms(providerConfig.enabledVendors);
  const activeGroups = (await client.listGroups()).filter(
    (g) =>
      g.status === "active" &&
      (!enabledPlatforms || enabledPlatforms.has(g.platform.toLowerCase())),
  );
  if (activeGroups.length === 0) return [];

  const groupKeys = new Map<
    number,
    { name: string; platform: string; apiKey: string }
  >();
  for (const group of activeGroups) {
    const apiKey = await client.getGroupApiKey(group.id);
    if (!apiKey) {
      consola.warn(
        t("CORE.SUB2API.NO_API_KEY", {
          name: providerConfig.name,
          group: group.name,
        }),
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
    t("CORE.SUB2API.GROUPS_WITH_KEYS", {
      name: providerConfig.name,
      count: groupKeys.size,
    }),
  );

  const accounts = await client.listAccounts();
  const activeAccounts = accounts.filter((a) => a.status === "active");
  consola.info(
    t("CORE.SUB2API.ACTIVE_ACCOUNTS", {
      name: providerConfig.name,
      active: activeAccounts.length,
      total: accounts.length,
    }),
  );

  const platformModels = new Map<string, Set<string>>();
  for (const account of activeAccounts) {
    const platform = account.platform.toLowerCase();
    if (!platformModels.has(platform)) platformModels.set(platform, new Set());
    const ids = (await client.getAccountModels(account.id)).map((m) =>
      m.id.replace(/^models\//, ""),
    );
    for (const id of filterModels(ids, config, providerConfig))
      platformModels.get(platform)!.add(id);
  }

  const resolved: ResolvedGroup[] = [];
  for (const [, info] of groupKeys) {
    const models = platformModels.get(info.platform);
    if (models?.size) resolved.push({ ...info, models });
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
  const enabledPlatforms = getEnabledPlatforms(providerConfig.enabledVendors);

  const resolved: ResolvedGroup[] = [];
  for (const group of groups) {
    const platform = group.platform.toLowerCase();
    if (enabledPlatforms && !enabledPlatforms.has(platform)) continue;
    const modelIds = await client.listGatewayModels(group.key, platform);
    const filtered = filterModels(modelIds, config, providerConfig);
    if (filtered.length === 0) {
      consola.warn(
        t("CORE.SUB2API.NO_MODELS_FOR_GROUP", {
          name: providerConfig.name,
          group: group.name ?? platform,
        }),
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
    t("CORE.SUB2API.GROUPS_WITH_MODELS", {
      name: providerConfig.name,
      count: resolved.length,
    }),
  );
  return resolved;
}

export async function processSub2ApiProvider(
  providerConfig: Sub2ApiProviderConfig,
  config: RuntimeConfig,
  ctx: { pricingSources: PricingSource[]; reverseMapping: Map<string, string> },
): Promise<ProviderResult> {
  const report: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  const endpointMetadata = { endpointPaths: new Map() };
  const client = new Sub2ApiClient(providerConfig);
  let totalStart: number | null = null;
  let groupKeysForBalance: string[] = [];
  const name = providerConfig.name;
  try {
    const resolvedGroups = providerConfig.adminApiKey
      ? await resolveViaAdmin(client, providerConfig, config)
      : await resolveViaGroups(client, providerConfig, config);
    if (resolvedGroups.length === 0) {
      report.error = t("CORE.ERROR.NO_GROUPS_WITH_MODELS");
      return { report, offers, endpointMetadata };
    }
    groupKeysForBalance = resolvedGroups.map((g) => g.apiKey);
    totalStart = sumBalances(
      await Promise.all(groupKeysForBalance.map((k) => client.fetchBalance(k))),
    );
    if (totalStart !== null)
      consola.info(
        t("CORE.PROVIDER.BALANCE", { name, amount: totalStart.toFixed(4) }),
      );
    let totalModels = 0,
      groupsProcessed = 0;

    for (const groupInfo of resolvedGroups) {
      const vendor =
        SUB2API_PLATFORM_TO_VENDOR[groupInfo.platform] ?? groupInfo.platform;
      const channelType =
        SUB2API_PLATFORM_CHANNEL_TYPES[groupInfo.platform.toLowerCase()] ??
        CHANNEL_TYPES.OPENAI;
      const useResponsesAPI = groupInfo.platform === "openai";
      const upstreamModels = [...groupInfo.models];
      const filterResult = await testAndFilterModels({
        allModels: upstreamModels,
        baseUrl: providerConfig.baseUrl,
        apiKey: groupInfo.apiKey,
        channelType,
        providerLabel: `${name}/${groupInfo.platform}`,
        testableModelTypes: getTestModelTypes(config, providerConfig),
        useResponsesAPI,
        capabilities: buildCapabilityMap(
          upstreamModels,
          lowercaseExposed(config),
          ctx,
        ),
      });
      const workingModels = filterResult.workingModels;
      if (workingModels.length === 0) {
        consola.warn(
          t("CORE.SUB2API.NO_WORKING_MODELS", {
            name,
            group: groupInfo.name,
            total: filterResult.testedCount,
          }),
        );
        continue;
      }
      consola.info(
        t("CORE.SUB2API.GROUP_WORKING", {
          name,
          platform: groupInfo.platform,
          working: workingModels.length,
          total: groupInfo.models.size,
        }),
      );
      const responsesApiEndpoints = useResponsesAPI
        ? ["openai-response"]
        : undefined;
      const offerModels: OfferModel[] = workingModels.map((upstreamName) => {
        const exposed = (
          config.modelMapping?.[upstreamName] ?? upstreamName
        ).toLowerCase();
        return {
          exposed,
          upstream: upstreamName,
          modelType: inferModelType(exposed, responsesApiEndpoints),
          endpoints: responsesApiEndpoints,
          normalizedEndpoints: responsesApiEndpoints,
          testDetail: filterResult.details?.find(
            (d) => d.model === upstreamName,
          ),
        };
      });
      offers.push({
        provider: name,
        providerKind: "sub2api",
        group: groupInfo.name,
        sanitizedBase: sanitizeGroupName(`${groupInfo.name}-${name}`),
        vendor,
        channelType,
        baseUrl: providerConfig.baseUrl,
        apiKey: groupInfo.apiKey,
        groupRatio: 1,
        channelRemark: `${groupInfo.platform} via ${name}`,
        models: offerModels,
        priceAdjustment: providerConfig.priceAdjustment,
        defaultAdjustment: -0.1,
      });
      totalModels += offerModels.length;
      groupsProcessed++;
    }

    report.groups = groupsProcessed;
    report.models = totalModels;
    report.success = groupsProcessed > 0;
    if (!report.success)
      report.error = t("CORE.ERROR.NO_GROUPS_PRODUCED_CHANNELS");
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  if (totalStart !== null && groupKeysForBalance.length > 0) {
    const totalEnd = sumBalances(
      await Promise.all(groupKeysForBalance.map((k) => client.fetchBalance(k))),
    );
    if (totalEnd !== null) {
      const cost = totalStart - totalEnd;
      recordProviderCost(name, cost);
      const amount = totalEnd.toFixed(4);
      consola.info(
        cost > 0
          ? t("CORE.PROVIDER.BALANCE_WITH_COST", {
              name,
              amount,
              cost: `$${cost.toFixed(4)}`,
            })
          : t("CORE.PROVIDER.BALANCE", { name, amount }),
      );
    }
  }

  return { report, offers, endpointMetadata };
}
