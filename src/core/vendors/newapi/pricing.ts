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
  ChatfireModel,
  EphoneModel,
  ModelInfo,
  PricingResponse,
  PricingResponseV2,
  PricingResponseV3,
  UpstreamPricing,
} from "./types";

export async function fetchPricing(
  ctx: ClientContext,
): Promise<UpstreamPricing> {
  const urls = [`${ctx.baseUrl}/api/pricing_new`, `${ctx.baseUrl}/api/pricing`];
  let raw: { success: boolean; [key: string]: unknown } | undefined;
  for (const url of urls) {
    // Most relays expose /api/pricing publicly, but some (e.g. zetatechs) require
    // the system token, so pass the client's auth headers either way.
    const body = await tryFetchJson<{
      success: boolean;
      [key: string]: unknown;
    }>(url, { headers: ctx.headers });
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
  const data = raw.data as { model_info?: unknown };
  if (Array.isArray(data.model_info))
    return parsePricingV3(ctx, raw as unknown as PricingResponseV3);
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
    audioRatio:
      m.audio_ratio != null && m.audio_ratio > 0 ? m.audio_ratio : undefined,
    audioCompletionRatio:
      m.audio_completion_ratio != null && m.audio_completion_ratio > 0
        ? m.audio_completion_ratio
        : undefined,
    billingMode: m.billing_mode || undefined,
    billingExpr: m.billing_expr || undefined,
    pricingVersion: m.pricing_version || undefined,
  }));

  const modelRatios: Record<string, number> = {};
  const completionRatios: Record<string, number> = {};
  const audioRatios: Record<string, number> = {};
  const audioCompletionRatios: Record<string, number> = {};
  const billingModes: Record<string, string> = {};
  const billingExprs: Record<string, string> = {};
  const pricingVersions: Record<string, string> = {};
  for (const m of data.data) {
    if (m.model_ratio > 0) modelRatios[m.model_name] = m.model_ratio;
    if (m.completion_ratio > 0)
      completionRatios[m.model_name] = m.completion_ratio;
    if (m.audio_ratio != null && m.audio_ratio > 0)
      audioRatios[m.model_name] = m.audio_ratio;
    if (m.audio_completion_ratio != null && m.audio_completion_ratio > 0)
      audioCompletionRatios[m.model_name] = m.audio_completion_ratio;
    if (m.billing_mode) billingModes[m.model_name] = m.billing_mode;
    if (m.billing_expr) billingExprs[m.model_name] = m.billing_expr;
    if (m.pricing_version) pricingVersions[m.model_name] = m.pricing_version;
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
    audioRatios,
    audioCompletionRatios,
    billingModes,
    billingExprs,
    pricingVersions,
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
    audioRatios: {},
    audioCompletionRatios: {},
    billingModes: {},
    billingExprs: {},
    pricingVersions: {},
  };
}

// new-api's per-token base: model_ratio 1 == $2 / M tokens. ephone quotes absolute
// USD/M, so ratio = usdPerM / 2 recovers the native ratio the rest of the engine wants.
const USD_PER_M_PER_RATIO = 2;

function endpointsFromModalities(m: {
  input?: string[];
  output?: string[];
}): string[] {
  const out = m.output ?? [];
  if (out.includes("video")) return ["openai-video"];
  return [];
}

// ephone: price_config.original_price.conditions[].price.
// - token: ratio + completionRatio (LLM). Multi-condition token = geo/context surcharge,
//   priced off the base condition (the surcharge is a runtime add-on).
// - call (per-request flat) and time (per-second): emit a flat modelPrice. The gateway's
//   native task adaptor applies resolution/duration multipliers at request time
//   (seconds/mode/resolution), so the flat base is the per-second rate (time) or per-unit
//   rate (call). Multi-condition media uses the CHEAPEST tier as the base; the adaptor's
//   EstimateBilling scales up for higher resolutions. Prices pass through verbatim (the
//   yuan-labeled-as-USD number is the retail-margin convention used across providers).
function decodeEphone(m: EphoneModel): ModelInfo | undefined {
  const orig = m.price_config?.original_price;
  const conditions = orig?.conditions ?? [];
  const price = conditions[0]?.price;
  const base: ModelInfo = {
    name: m.model_name,
    ratio: 1,
    completionRatio: 1,
    groups: m.enable_groups ?? [],
    vendorId: m.vendor_id,
    supportedEndpoints: endpointsFromModalities(m.modalities ?? {}),
  };
  if (!price) return base;
  if (price.quota_type === "token") {
    const input = price.input_token_price ?? 0;
    const output = price.output_token_price ?? input;
    if (input <= 0) return base;
    base.ratio = input / USD_PER_M_PER_RATIO;
    base.completionRatio = output > 0 ? output / input : 1;
    if (price.cache_read_token_price != null && input > 0)
      base.cacheRatio = price.cache_read_token_price / input;
    if (price.cache_create_token_price != null && input > 0)
      base.createCacheRatio = price.cache_create_token_price / input;
    return base;
  }
  // Flat media price: per-unit (call) or per-second (time). Pick the cheapest condition's
  // value so multi-condition resolution tiers start at the base rate.
  const flat = cheapestFlatPrice(conditions);
  if (flat != null && flat > 0) {
    base.modelPrice = flat;
    base.quotaType = 1;
  }
  return base;
}

// Lowest per-unit/per-second price across an ephone model's conditions (resolution tiers).
function cheapestFlatPrice(
  conditions: NonNullable<
    NonNullable<EphoneModel["price_config"]>["original_price"]
  >["conditions"],
): number | undefined {
  let min: number | undefined;
  for (const c of conditions ?? []) {
    const p = c.price;
    if (!p) continue;
    const v = p.per_second_price ?? p.model_price;
    if (v != null && v > 0 && (min === undefined || v < min)) min = v;
  }
  return min;
}

// chatfire: price_info[group].default. Native new-api ratios; pick the cheapest
// enable-group so failover prices off the best lane.
function decodeChatfire(m: ChatfireModel): ModelInfo | undefined {
  const groups = Object.entries(m.price_info ?? {});
  if (!groups.length) return undefined;
  let best: (typeof groups)[number][1]["default"] | undefined;
  for (const [, g] of groups) {
    const d = g.default;
    if (!d) continue;
    if (!best || (d.model_ratio ?? Infinity) < (best.model_ratio ?? Infinity))
      best = d;
  }
  if (!best) return undefined;
  const info: ModelInfo = {
    name: m.model_name,
    ratio: best.model_ratio && best.model_ratio > 0 ? best.model_ratio : 1,
    completionRatio: best.model_completion_ratio ?? 1,
    groups: m.enable_groups ?? Object.keys(m.price_info ?? {}),
    vendorId: m.vendor_id,
    supportedEndpoints: m.supported_endpoint_types ?? [],
  };
  if (best.model_cache_ratio != null && best.model_cache_ratio >= 0)
    info.cacheRatio = best.model_cache_ratio;
  if (best.model_create_cache_ratio != null && best.model_create_cache_ratio >= 0)
    info.createCacheRatio = best.model_create_cache_ratio;
  if (best.model_audio_ratio != null && best.model_audio_ratio > 0)
    info.audioRatio = best.model_audio_ratio;
  if (
    best.model_audio_completion_ratio != null &&
    best.model_audio_completion_ratio > 0
  )
    info.audioCompletionRatio = best.model_audio_completion_ratio;
  // per-call (quota_type 0) flat price; grid/special (>=2) forwarded as quotaType.
  if (best.quota_type === 0 && (best.model_price ?? 0) > 0) {
    info.modelPrice = best.model_price;
    info.quotaType = 1;
  } else if (best.quota_type >= 2) {
    info.quotaType = best.quota_type;
  }
  return info;
}

function parsePricingV3(
  ctx: ClientContext,
  raw: PricingResponseV3,
): UpstreamPricing {
  const d = raw.data;
  const rows = d.model_info ?? [];
  const isEphone = rows.some(
    (m) => (m as EphoneModel).price_config !== undefined,
  );

  const models: ModelInfo[] = [];
  for (const row of rows) {
    const info = isEphone
      ? decodeEphone(row as EphoneModel)
      : decodeChatfire(row as ChatfireModel);
    if (info) models.push(info);
  }

  const groupRatios: Record<string, number> = {};
  for (const [name, g] of Object.entries(d.group_info ?? {}))
    if (name !== "") groupRatios[name] = g.GroupRatio ?? 1;

  const groupModels = new Map<string, Set<string>>();
  for (const info of models)
    for (const group of info.groups) {
      if (!groupModels.has(group)) groupModels.set(group, new Set());
      groupModels.get(group)!.add(info.name);
    }
  const groups: GroupInfo[] = Object.entries(d.group_info ?? {})
    .filter(([name]) => name !== "")
    .map(([name, g]) => ({
      name,
      description: g.DisplayNameEn || g.DisplayName || name,
      ratio: g.GroupRatio ?? 1,
      models: Array.from(groupModels.get(name) ?? []),
      channelType: CHANNEL_TYPES.OPENAI,
    }));

  const modelRatios: Record<string, number> = {};
  const completionRatios: Record<string, number> = {};
  const audioRatios: Record<string, number> = {};
  const audioCompletionRatios: Record<string, number> = {};
  for (const info of models) {
    if (info.ratio > 0) modelRatios[info.name] = info.ratio;
    if (info.completionRatio > 0)
      completionRatios[info.name] = info.completionRatio;
    if (info.audioRatio != null) audioRatios[info.name] = info.audioRatio;
    if (info.audioCompletionRatio != null)
      audioCompletionRatios[info.name] = info.audioCompletionRatio;
  }

  const vendorIdToName: Record<number, string> = {};
  for (const v of d.vendor_info ?? []) vendorIdToName[v.id] = v.name;

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
    groupRatios,
    modelRatios,
    completionRatios,
    vendorIdToName,
    endpointPaths: {},
    audioRatios,
    audioCompletionRatios,
    billingModes: {},
    billingExprs: {},
    pricingVersions: {},
  };
}
