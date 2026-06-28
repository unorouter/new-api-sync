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
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { tryFetchJson } from "@core/infra/http";
import { testAndFilterModels } from "@core/testing/runner";
import type { ProviderReport } from "@core/types";
import type { OpenRouterProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildCapabilityMap, lowercaseExposed } from "../shared/capability-map";
import { withCostTracking } from "../shared/cost-tracker";
import { partitionByVendor } from "../shared/partition";
import { discoverOpenRouterFreeModels } from "./discovery";

async function fetchOpenRouterBalance(
  baseUrl: string,
  apiKey: string,
): Promise<number | null> {
  const data = await tryFetchJson<{
    data?: { total_credits?: number; total_usage?: number };
  }>(`${baseUrl.replace(/\/$/, "")}/v1/credits`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const c = data?.data?.total_credits,
    u = data?.data?.total_usage;
  return c === undefined || u === undefined ? null : c - u;
}

export async function processOpenRouterProvider(
  providerConfig: OpenRouterProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): Promise<ProviderResult> {
  const name = providerConfig.name;
  const report: ProviderReport = {
    name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  const endpointMetadata = { endpointPaths: new Map() };

  await withCostTracking(
    name,
    () =>
      ctx.dryRun
        ? Promise.resolve(null)
        : fetchOpenRouterBalance(providerConfig.baseUrl, providerConfig.apiKey),
    async () => {
      try {
        const catalogue = await discoverOpenRouterFreeModels(
          providerConfig.baseUrl,
          providerConfig.apiKey,
        );
        consola.info(
          t("CORE.OPENROUTER.DISCOVERED_FREE", {
            name,
            count: catalogue.freeIds.length,
          }),
        );

        const enabledGlobs =
          getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
        const freeSet = new Set(catalogue.freeIds);
        const paidSet = new Set<string>();
        for (const id of enabledGlobs) {
          if (id.includes("*") || id.includes("?") || freeSet.has(id)) continue;
          paidSet.add(id);
        }

        const candidateIds = [...freeSet, ...paidSet];
        if (candidateIds.length === 0) {
          report.error = t("CORE.ERROR.NO_MODELS_FOUND");
          return;
        }

        const vendorFilterLower = providerConfig.enabledVendors?.map((v) =>
          v.toLowerCase(),
        );
        const filtered = candidateIds.filter((id) => {
          const bare = toBareName(id);
          if (
            matchesBlacklist(bare, config.blacklist, name) ||
            matchesBlacklist(id, config.blacklist, name)
          )
            return false;
          if (vendorFilterLower?.length) {
            const slash = id.indexOf("/");
            const vendor = slash >= 0 ? id.slice(0, slash).toLowerCase() : "";
            if (!vendorFilterLower.includes(vendor)) return false;
          }
          if (
            config.modelFilter?.length &&
            !matchesAnyPattern(id, config.modelFilter) &&
            !matchesAnyPattern(bare, config.modelFilter)
          )
            return false;
          return true;
        });

        if (filtered.length === 0) {
          report.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
          return;
        }

        consola.info(
          t("CORE.OPENROUTER.PROBING", { name, count: filtered.length }),
        );

        const filterResult = await testAndFilterModels({
          allModels: filtered,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          channelType: CHANNEL_TYPES.OPENAI,
          providerLabel: name,
          testableModelTypes: new Set(["text"]),
          acceptRateLimited: providerConfig.acceptRateLimited ?? false,
          capabilities: buildCapabilityMap(
            filtered,
            lowercaseExposed(config),
            ctx,
          ),
        });
        const working = filterResult.workingModels;
        const details = filterResult.details ?? [];

        consola.info(
          t("CORE.OPENROUTER.WORKING", {
            name,
            working: working.length,
            total: filtered.length,
          }),
        );
        if (working.length === 0) {
          report.error = t("CORE.ERROR.NO_WORKING_MODELS");
          return;
        }

        const resolutions = resolveBareNames(working, config.modelMapping);
        const reverseMapping = buildChannelModelMapping(resolutions);
        const freeResolutions = resolutions.filter((r) =>
          freeSet.has(r.upstream),
        );
        const paidResolutions = resolutions.filter(
          (r) => !freeSet.has(r.upstream),
        );

        let totalVendors = 0;
        const emitTier = (
          tier: typeof resolutions,
          sanitizedBase: string,
          groupRatio: number,
          remarkLabel: string,
          isFree: boolean,
        ) => {
          if (tier.length === 0) return;
          const byVendor = partitionByVendor(tier, (r) => r.exposed, "other");
          for (const [vendor, vendorResolutions] of byVendor) {
            const offerModels: OfferModel[] = vendorResolutions.map((r) => {
              const m: OfferModel = {
                exposed: r.exposed,
                upstream: reverseMapping[r.exposed] ?? r.upstream,
                modelType: "text",
                testDetail: details.find((d) => d.model === r.upstream),
              };
              if (isFree) m.isFree = true;
              return m;
            });
            const offer: UpstreamOffer = {
              provider: name,
              providerKind: "openrouter",
              group: vendor,
              sanitizedBase,
              vendor,
              channelType: CHANNEL_TYPES.OPENROUTER,
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              groupRatio,
              channelRemark: `OpenRouter ${remarkLabel} via ${name}`,
              models: offerModels,
              priceAdjustment: providerConfig.priceAdjustment,
              defaultAdjustment: 0,
            };
            if (!isFree) offer.paidTier = true;
            else offer.isFreeTier = true;
            offers.push(offer);
            totalVendors++;
          }
        };

        emitTier(
          freeResolutions,
          sanitizeGroupName(name),
          providerConfig.ratio,
          "free",
          true,
        );
        emitTier(
          paidResolutions,
          sanitizeGroupName(`${name}-paid`),
          1,
          "paid",
          false,
        );

        consola.info(
          t("CORE.OPENROUTER.SUMMARY", {
            name,
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
    },
  );
  return { report, offers, endpointMetadata };
}
