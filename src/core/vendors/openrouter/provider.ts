import {
  buildChannelModelMapping,
  resolveBareNames,
  toBareName,
} from "@core/catalog/bare-name";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import {
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  UpstreamOffer,
} from "@core/pricing/offers";
import {
  resolveSourceMetadata,
  type PricingSource,
} from "@core/pricing/resolver";
import { tryFetchJson } from "@core/runtime";
import {
  testAndFilterModels,
  type ModelCapabilityHint,
} from "@core/testing/runner";
import type { ProviderReport } from "@core/types";
import type { OpenRouterProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { withCostTracking } from "../shared/cost-tracker";
import { partitionByVendor } from "../shared/partition";
import { discoverOpenRouterFreeModels } from "./discovery";

/**
 * Fetch the OpenRouter account balance via /api/v1/credits. Returns the
 * remaining credit (total_credits - total_usage) in dollars, or null when
 * the endpoint is unreachable or the response shape is unexpected.
 */
async function fetchOpenRouterBalance(
  baseUrl: string,
  apiKey: string,
): Promise<number | null> {
  const data = await tryFetchJson<{
    data?: { total_credits?: number; total_usage?: number };
  }>(`${baseUrl.replace(/\/$/, "")}/v1/credits`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (
    !data ||
    data.data?.total_credits === undefined ||
    data.data?.total_usage === undefined
  ) {
    return null;
  }
  return data.data.total_credits - data.data.total_usage;
}

function buildCapabilityMap(
  upstreamModels: string[],
  config: RuntimeConfig,
  ctx: {
    pricingSources: PricingSource[];
    reverseMapping: Map<string, string>;
  },
): Map<string, ModelCapabilityHint> {
  const map = new Map<string, ModelCapabilityHint>();
  for (const upstream of upstreamModels) {
    const exposed = (
      config.modelMapping?.[upstream] ?? upstream
    ).toLowerCase();
    const md = resolveSourceMetadata(
      exposed,
      ctx.pricingSources,
      ctx.reverseMapping,
    );
    if (md.supportsTools !== undefined || md.isReasoning !== undefined) {
      map.set(upstream, {
        supportsTools: md.supportsTools,
        isReasoning: md.isReasoning,
      });
    }
  }
  return map;
}

export async function processOpenRouterProvider(
  providerConfig: OpenRouterProviderConfig,
  config: RuntimeConfig,
  ctx: {
    pricingSources: PricingSource[];
    reverseMapping: Map<string, string>;
  },
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

  const fetchBalance = () =>
    fetchOpenRouterBalance(providerConfig.baseUrl, providerConfig.apiKey);

  await withCostTracking(providerConfig.name, fetchBalance, async () => {
    try {
      // Default sync: every truly-free model from the catalogue, where
      // "free" means at least one healthy upstream endpoint has zero
      // pricing. The :free suffix alone is not trusted - some headline-free
      // models still bill on every actual endpoint.
      const catalogue = await discoverOpenRouterFreeModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      consola.info(
        t("CORE.OPENROUTER.DISCOVERED_FREE", {
          name: providerConfig.name,
          count: catalogue.freeIds.length,
        }),
      );

      // enabledModels is the paid opt-in surface: any literal IDs added
      // here are forced into the paid set. Globs are unsupported here
      // because each entry must resolve to a concrete OpenRouter ID.
      const enabledGlobs =
        getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
      const explicitPaidIds = enabledGlobs.filter(
        (g) => !g.includes("*") && !g.includes("?"),
      );

      const freeSet = new Set(catalogue.freeIds);
      const paidSet = new Set<string>();
      for (const id of explicitPaidIds) {
        if (freeSet.has(id)) continue; // already free, no need to opt in
        paidSet.add(id);
        consola.debug(
          t("CORE.OPENROUTER.ADDED_PAID_EXTRA", {
            name: providerConfig.name,
            model: id,
          }),
        );
      }

      const candidateIds = [...freeSet, ...paidSet];
      if (candidateIds.length === 0) {
        report.error = t("CORE.ERROR.NO_MODELS_FOUND");
        return { report, offers, endpointMetadata };
      }

      const vendorFilter = providerConfig.enabledVendors;
      const filtered = candidateIds.filter((id) => {
        const bare = toBareName(id);
        if (
          matchesBlacklist(bare, config.blacklist, providerConfig.name) ||
          matchesBlacklist(id, config.blacklist, providerConfig.name)
        ) {
          return false;
        }
        if (vendorFilter?.length) {
          const slash = id.indexOf("/");
          const vendor = slash >= 0 ? id.slice(0, slash).toLowerCase() : "";
          if (!vendorFilter.map((v) => v.toLowerCase()).includes(vendor)) {
            return false;
          }
        }
        if (config.modelFilter?.length) {
          if (
            !matchesAnyPattern(id, config.modelFilter) &&
            !matchesAnyPattern(bare, config.modelFilter)
          ) {
            return false;
          }
        }
        return true;
      });

      if (filtered.length === 0) {
        report.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
        return { report, offers, endpointMetadata };
      }

      consola.info(
        t("CORE.OPENROUTER.PROBING", {
          name: providerConfig.name,
          count: filtered.length,
        }),
      );

      const capabilities = buildCapabilityMap(filtered, config, ctx);
      const filterResult = await testAndFilterModels({
        allModels: filtered,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        channelType: CHANNEL_TYPES.OPENAI,
        providerLabel: providerConfig.name,
        testableModelTypes: new Set(["text"]),
        acceptRateLimited: true,
        capabilities,
      });
      const working = filterResult.workingModels;
      const details = filterResult.details ?? [];

      consola.info(
        t("CORE.OPENROUTER.WORKING", {
          name: providerConfig.name,
          working: working.length,
          total: filtered.length,
        }),
      );

      if (working.length === 0) {
        report.error = t("CORE.ERROR.NO_WORKING_MODELS");
        return { report, offers, endpointMetadata };
      }

      const resolutions = resolveBareNames(working, config.modelMapping);
      const reverseMapping = buildChannelModelMapping(resolutions);

      const freeResolutions = resolutions.filter((r) => freeSet.has(r.upstream));
      const paidResolutions = resolutions.filter((r) => !freeSet.has(r.upstream));

      const sanitizedFree = sanitizeGroupName(providerConfig.name);
      const sanitizedPaid = sanitizeGroupName(`${providerConfig.name}-paid`);

      let totalVendors = 0;

      // Free offers — one per vendor.
      if (freeResolutions.length > 0) {
        const byVendor = partitionByVendor(
          freeResolutions,
          (r) => r.exposed,
          "other",
        );
        for (const [vendor, vendorResolutions] of byVendor) {
          const offerModels: OfferModel[] = vendorResolutions.map((r) => {
            const detail = details.find((d) => d.model === r.upstream);
            return {
              exposed: r.exposed,
              upstream: reverseMapping[r.exposed] ?? r.upstream,
              modelType: "text",
              isFree: true,
              testDetail: detail,
            };
          });
          offers.push({
            provider: providerConfig.name,
            providerKind: "openrouter",
            group: vendor,
            sanitizedBase: sanitizedFree,
            vendor,
            channelType: CHANNEL_TYPES.OPENROUTER,
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            groupRatio: providerConfig.ratio,
            channelRemark: `OpenRouter free via ${providerConfig.name}`,
            models: offerModels,
            priceAdjustment: providerConfig.priceAdjustment,
            defaultAdjustment: 0,
          });
          totalVendors++;
        }
      }

      // Paid offers — one per vendor with paidTier:true. Compute picks the
      // single shared group_ratio per offer from the discrete candidate ladder.
      if (paidResolutions.length > 0) {
        const byVendor = partitionByVendor(
          paidResolutions,
          (r) => r.exposed,
          "other",
        );
        for (const [vendor, vendorResolutions] of byVendor) {
          const offerModels: OfferModel[] = vendorResolutions.map((r) => {
            const detail = details.find((d) => d.model === r.upstream);
            return {
              exposed: r.exposed,
              upstream: reverseMapping[r.exposed] ?? r.upstream,
              modelType: "text",
              testDetail: detail,
            };
          });
          offers.push({
            provider: providerConfig.name,
            providerKind: "openrouter",
            group: vendor,
            sanitizedBase: sanitizedPaid,
            vendor,
            channelType: CHANNEL_TYPES.OPENROUTER,
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            groupRatio: 1,
            channelRemark: `OpenRouter paid via ${providerConfig.name}`,
            models: offerModels,
            priceAdjustment: providerConfig.priceAdjustment,
            defaultAdjustment: 0,
            paidTier: true,
          });
          totalVendors++;
        }
      }

      consola.info(
        t("CORE.OPENROUTER.SUMMARY", {
          name: providerConfig.name,
          total: resolutions.length,
          free: freeResolutions.length,
          paid: paidResolutions.length,
          vendors: totalVendors,
        }),
      );

      report.groups = totalVendors;
      report.models = resolutions.length;
      report.success = true;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  });

  return { report, offers, endpointMetadata };
}
