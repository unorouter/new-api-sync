import {
  CHANNEL_TYPES,
  inferChannelType,
} from "@core/catalog/constants/channel-types";
import { tryFetchJson } from "@core/infra/http";
import type { GroupInfo } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { ClientContext } from "./context";
import type {
  ModelInfo,
  PricingResponse,
  PricingResponseV2,
  UpstreamPricing,
} from "./types";

export async function fetchPricing(
  ctx: ClientContext,
): Promise<UpstreamPricing> {
  const urls = [`${ctx.baseUrl}/api/pricing_new`, `${ctx.baseUrl}/api/pricing`];
  let raw: { success: boolean; [key: string]: unknown } | undefined;
  for (const url of urls) {
    const body = await tryFetchJson<{
      success: boolean;
      [key: string]: unknown;
    }>(url);
    if (!body?.success || !body.data) continue;
    if (url.endsWith("/pricing_new") && !Array.isArray(body.data)) continue;
    raw = body;
    break;
  }
  if (!raw) throw new Error(t("ERROR.NEWAPI_FETCH_PRICING_FAILED"));

  const supportedEndpoint = (raw.supported_endpoint ?? {}) as Record<
    string,
    { path: string; method: string }
  >;
  if (Array.isArray(raw.data))
    return parsePricingV1(ctx, raw as unknown as PricingResponse);
  const result = parsePricingV2(ctx, raw as unknown as PricingResponseV2);
  result.endpointPaths = supportedEndpoint;
  return result;
}

function parsePricingV1(
  ctx: ClientContext,
  data: PricingResponse,
): UpstreamPricing {
  const groupModels = new Map<string, Set<string>>();
  const groupEndpoints = new Map<string, Set<string>>();
  for (const model of data.data) {
    const endpoints = model.supported_endpoint_types ?? model.endpoints ?? [];
    for (const group of model.enable_groups) {
      if (!groupModels.has(group)) {
        groupModels.set(group, new Set());
        groupEndpoints.set(group, new Set());
      }
      groupModels.get(group)!.add(model.model_name);
      for (const endpoint of endpoints)
        groupEndpoints.get(group)!.add(endpoint);
    }
  }

  const groups: GroupInfo[] = Object.entries(
    data.usable_group ?? data.group_names ?? {},
  )
    .filter(([name]) => name !== "")
    .map(([name, description]) => ({
      name,
      description,
      ratio: data.group_ratio[name] ?? 1,
      models: Array.from(groupModels.get(name) ?? []),
      channelType: inferChannelType(Array.from(groupEndpoints.get(name) ?? [])),
    }));

  const models: ModelInfo[] = data.data.map((m) => ({
    name: m.model_name,
    ratio: m.model_ratio,
    completionRatio: m.completion_ratio,
    cacheRatio:
      m.cache_ratio !== undefined && m.cache_ratio >= 0
        ? m.cache_ratio
        : undefined,
    createCacheRatio:
      m.create_cache_ratio !== undefined && m.create_cache_ratio >= 0
        ? m.create_cache_ratio
        : undefined,
    groups: m.enable_groups,
    vendorId: m.vendor_id,
    supportedEndpoints: m.supported_endpoint_types ?? m.endpoints ?? [],
    modelPrice:
      m.quota_type !== 0 && m.model_price > 0 ? m.model_price : undefined,
    quotaType: m.quota_type >= 2 ? m.quota_type : undefined,
  }));

  const modelRatios: Record<string, number> = {};
  const completionRatios: Record<string, number> = {};
  for (const m of data.data) {
    if (m.model_ratio > 0) modelRatios[m.model_name] = m.model_ratio;
    if (m.completion_ratio > 0)
      completionRatios[m.model_name] = m.completion_ratio;
  }

  const vendorIdToName: Record<number, string> = {};
  if (data.vendors) for (const v of data.vendors) vendorIdToName[v.id] = v.name;

  consola.info(
    t("CORE.NEWAPI.V1_FORMAT", {
      name: ctx.name,
      groups: groups.length,
      models: models.length,
    }),
  );
  return {
    groups,
    models,
    groupRatios: data.group_ratio,
    modelRatios,
    completionRatios,
    vendorIdToName,
    endpointPaths: data.supported_endpoint ?? {},
  };
}

function parsePricingV2(
  ctx: ClientContext,
  raw: PricingResponseV2,
): UpstreamPricing {
  const d = raw.data;
  const groupRatios: Record<string, number> = {};
  const modelRatios: Record<string, number> = {};
  const completionRatios: Record<string, number> = {
    ...d.model_completion_ratio,
  };

  const groups: GroupInfo[] = Object.entries(d.model_group)
    .filter(([name]) => name !== "")
    .map(([name, group]) => {
      const modelNames = Object.keys(group.ModelPrice);
      groupRatios[name] = group.GroupRatio;
      for (const [modelName, pricing] of Object.entries(group.ModelPrice)) {
        if (pricing.price > 0) {
          const prev = modelRatios[modelName];
          if (prev === undefined || pricing.price < prev)
            modelRatios[modelName] = pricing.price;
        }
      }
      return {
        name,
        description: group.DisplayName || name,
        ratio: group.GroupRatio,
        models: modelNames,
        channelType: CHANNEL_TYPES.OPENAI,
      };
    });

  const allModels = new Map<string, ModelInfo>();
  for (const [groupName, group] of Object.entries(d.model_group)) {
    for (const [modelName, pricing] of Object.entries(group.ModelPrice)) {
      if (!allModels.has(modelName)) {
        allModels.set(modelName, {
          name: modelName,
          ratio: pricing.price || 1,
          completionRatio: d.model_completion_ratio[modelName] ?? 1,
          groups: [],
        });
      }
      allModels.get(modelName)!.groups.push(groupName);
    }
  }
  const models = Array.from(allModels.values());

  consola.info(
    t("CORE.NEWAPI.V2_FORMAT", {
      name: ctx.name,
      groups: groups.length,
      models: models.length,
    }),
  );
  return {
    groups,
    models,
    groupRatios,
    modelRatios,
    completionRatios,
    vendorIdToName: {},
    endpointPaths: {},
  };
}
