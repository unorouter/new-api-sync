import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import {
  buildChannelModelMapping,
  resolveBareNames,
  toBareName,
} from "@core/models/bare-name";
import { CHANNEL_TYPES } from "@core/models/constants/channel-types";
import {
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@core/models/constants/patterns";
import { inferVendorFromModelName } from "@core/models/constants/vendor-matchers";
import {
  recordProviderCost,
  testAndFilterModels,
} from "@core/models/testing/runner";
import { tryFetchJson } from "@core/runtime/http";
import type {
  OfferModel,
  ProviderResult,
  UpstreamOffer,
} from "@core/pricing/offers";
import type { OpenRouterProviderConfig } from "@core/validations/config";
import type { ProviderReport } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import { discoverOpenRouterFreeModels } from "./discovery";

interface BareResolution {
  exposed: string;
  upstream: string;
}

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

function partitionByVendor(
  resolutions: BareResolution[],
): Map<string, BareResolution[]> {
  const out = new Map<string, BareResolution[]>();
  for (const r of resolutions) {
    const vendor = inferVendorFromModelName(r.exposed) ?? "other";
    let arr = out.get(vendor);
    if (!arr) {
      arr = [];
      out.set(vendor, arr);
    }
    arr.push(r);
  }
  return out;
}

export async function processOpenRouterProvider(
  providerConfig: OpenRouterProviderConfig,
  config: RuntimeConfig,
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

  const startBalance = await fetchOpenRouterBalance(
    providerConfig.baseUrl,
    providerConfig.apiKey,
  );
  if (startBalance !== null) {
    consola.info(
      `[${providerConfig.name}] Balance: $${startBalance.toFixed(4)}`,
    );
  }

  try {
    let candidateIds: string[];
    let isFreeById = new Map<string, boolean>();

    if (providerConfig.models?.length) {
      candidateIds = [...providerConfig.models];
      for (const id of candidateIds) isFreeById.set(id, id.endsWith(":free"));
      consola.info(
        t("CORE.OPENROUTER.EXPLICIT_SKIP_DISCOVERY", {
          name: providerConfig.name,
          count: candidateIds.length,
        }),
      );
    } else {
      const catalogue = await discoverOpenRouterFreeModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      isFreeById = catalogue.isFreeById;
      consola.info(
        t("CORE.OPENROUTER.DISCOVERED_FREE", {
          name: providerConfig.name,
          count: catalogue.freeIds.length,
        }),
      );

      const enabledGlobs =
        getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
      const extras = enabledGlobs.filter(
        (g) => !g.includes("*") && !g.includes("?"),
      );
      const set = new Set(catalogue.freeIds);
      for (const extra of extras) {
        if (!set.has(extra)) {
          set.add(extra);
          if (!isFreeById.has(extra)) {
            isFreeById.set(extra, extra.endsWith(":free"));
          }
          consola.debug(
            t("CORE.OPENROUTER.ADDED_EXTRA", {
              name: providerConfig.name,
              model: extra,
            }),
          );
        }
      }
      candidateIds = [...set];
    }

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

    const filterResult = await testAndFilterModels({
      allModels: filtered,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      channelType: CHANNEL_TYPES.OPENAI,
      providerLabel: providerConfig.name,
      testableModelTypes: new Set(["text"]),
      acceptRateLimited: true,
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

    const freeResolutions = resolutions.filter(
      (r) => isFreeById.get(r.upstream) ?? r.upstream.endsWith(":free"),
    );
    const paidResolutions = resolutions.filter(
      (r) => !(isFreeById.get(r.upstream) ?? r.upstream.endsWith(":free")),
    );

    const sanitizedFree = sanitizeGroupName(providerConfig.name);
    const sanitizedPaid = sanitizeGroupName(`${providerConfig.name}-paid`);

    let totalVendors = 0;

    // Free offers — one per vendor.
    if (freeResolutions.length > 0) {
      const byVendor = partitionByVendor(freeResolutions);
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
          maxRatioCap: providerConfig.maxRatioCap ?? config.maxRatioCap,
        });
        totalVendors++;
      }
    }

    // Paid offers — one per vendor with paidTier:true. Compute picks the
    // single shared group_ratio per offer from the discrete candidate ladder.
    if (paidResolutions.length > 0) {
      const byVendor = partitionByVendor(paidResolutions);
      for (const [vendor, vendorResolutions] of byVendor) {
        const offerModels: OfferModel[] = vendorResolutions.map((r) => {
          const detail = details.find((d) => d.model === r.upstream);
          return {
            exposed: r.exposed,
            upstream: reverseMapping[r.exposed] ?? r.upstream,
            modelType: "text",
            // upstreamRatio is undefined; compute uses canonical for written
            // ratio and the cap-fit ladder for group_ratio.
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
          maxRatioCap: providerConfig.maxRatioCap ?? config.maxRatioCap,
          paidTier: true,
        });
        totalVendors++;
      }
    }

    consola.info(
      `[${providerConfig.name}] ${resolutions.length} model(s) (${freeResolutions.length} free, ${paidResolutions.length} paid) across ${totalVendors} vendor channel(s)`,
    );

    report.groups = totalVendors;
    report.models = resolutions.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  if (startBalance !== null) {
    const finalBalance = await fetchOpenRouterBalance(
      providerConfig.baseUrl,
      providerConfig.apiKey,
    );
    if (finalBalance !== null) {
      const cost = startBalance - finalBalance;
      recordProviderCost(providerConfig.name, cost);
      consola.info(
        `[${providerConfig.name}] Balance: $${finalBalance.toFixed(4)}` +
          (cost > 0 ? ` | Test cost: $${cost.toFixed(4)}` : ""),
      );
    }
  }

  return { report, offers, endpointMetadata };
}
