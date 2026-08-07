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
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { resolvePriceAdjustment } from "@core/pricing";
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

// new-api's per-token base: model_ratio 1 == $2/M tokens.
const USD_PER_M_PER_RATIO = 2;
// Cost + 50% when a provider's priceAdjustment default is unset.
const DEFAULT_PAID_MARKUP = 1.5;
const MIN_HOST_UPTIME_PCT = 90;
// fp8 is the floor. Anything coarser trades output quality for a price we are not
// short of alternatives at, and "unknown" covers the full-precision hosts, so only
// the explicitly-lower tiers are named here.
const SUB_FP8_QUANTIZATIONS = new Set(["fp4", "int4", "nf4", "fp6", "int8"]);
// Hosts we already relay directly. Routing to them via OpenRouter pays OR's cut for
// a lane we own, so they never win the cheapest-host pick.
const EXCLUDED_HOSTS = new Set(["deepinfra"]);

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
        const enabledGlobs =
          getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
        // Exact (non-glob) enabled ids = explicitly-requested paid models. Fetch
        // their per-host endpoint pricing during discovery.
        const requestedPaidIds = enabledGlobs.filter(
          (id) => !id.includes("*") && !id.includes("?"),
        );

        const catalogue = await discoverOpenRouterFreeModels(
          providerConfig.baseUrl,
          providerConfig.apiKey,
          requestedPaidIds,
        );
        consola.info(
          t("CORE.OPENROUTER.DISCOVERED_FREE", {
            name,
            count: catalogue.freeIds.length,
          }),
        );

        const freeSet = new Set(catalogue.freeIds);
        const paidSet = new Set<string>();
        for (const id of requestedPaidIds) {
          if (freeSet.has(id)) continue;
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

        // Only the free tier is probed. A paid probe is a billed request per model per
        // run, and OpenRouter already removes a model from its own catalog when the
        // upstream drops it; the free tier has no such guarantee and throttles constantly,
        // so it still earns the test. Paid models pass through untested.
        const toProbe = filtered.filter((id) => freeSet.has(id));
        const untested = filtered.filter((id) => !freeSet.has(id));

        let working = untested;
        let details: Awaited<
          ReturnType<typeof testAndFilterModels>
        >["details"] = [];
        if (toProbe.length > 0) {
          consola.info(
            t("CORE.OPENROUTER.PROBING", { name, count: toProbe.length }),
          );
          const filterResult = await testAndFilterModels({
            allModels: toProbe,
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            channelType: CHANNEL_TYPES.OPENAI,
            providerLabel: name,
            testableModelTypes: new Set(["text"]),
            acceptRateLimited: providerConfig.acceptRateLimited ?? false,
            capabilities: buildCapabilityMap(
              toProbe,
              lowercaseExposed(config),
              ctx,
            ),
          });
          working = [...untested, ...filterResult.workingModels];
          details = filterResult.details ?? [];
        }

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
        const emitFreeTier = () => {
          if (freeResolutions.length === 0) return;
          const byVendor = partitionByVendor(
            freeResolutions,
            (r) => r.exposed,
            "other",
          );
          for (const [vendor, vendorResolutions] of byVendor) {
            const offerModels: OfferModel[] = vendorResolutions.map((r) => ({
              exposed: r.exposed,
              upstream: reverseMapping[r.exposed] ?? r.upstream,
              modelType: "text",
              testDetail: details.find((d) => d.model === r.upstream),
              isFree: true,
            }));
            offers.push({
              provider: name,
              providerKind: "openrouter",
              group: vendor,
              sanitizedBase: sanitizeGroupName(name),
              vendor,
              channelType: CHANNEL_TYPES.OPENROUTER,
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              groupRatio: providerConfig.ratio,
              channelRemark: `OpenRouter free via ${name}`,
              models: offerModels,
              priceAdjustment: providerConfig.priceAdjustment,
              defaultAdjustment: 0,
              isFreeTier: true,
            });
            totalVendors++;
          }
        };

        // Paid: one channel per (model, upstream host). Each pins its host via
        // provider.only + no-fallback, priced off that host's real cost * markup.
        // Margin is baked into groupRatio (adj resolved to 0) so capAbove1x leaves
        // it untouched (a positive reprice would collapse to +5% since the model's
        // own price is its 1x list). Markup is resolved PER MODEL (against the
        // exposed name) so config priceAdjustment can key individual models, e.g.
        // a 50% (0.5) lane alongside a 55% default.
        const emitPaidPerHost = () => {
          for (const r of paidResolutions) {
            const hosts = catalogue.paidEndpoints.get(r.upstream);
            if (!hosts?.length) {
              consola.warn(
                t("CORE.OPENROUTER.PAID_NO_PRICING", {
                  name,
                  model: r.upstream,
                }),
              );
              continue;
            }
            const markup =
              1 +
              resolvePriceAdjustment({
                adj: providerConfig.priceAdjustment,
                model: r.exposed,
                vendor: inferVendorFromModelName(r.exposed) ?? "",
                modelType: "text",
                fallback: DEFAULT_PAID_MARKUP - 1,
                modelMapping: config.modelMapping,
              });
            const vendor = inferVendorFromModelName(r.exposed) ?? "other";
            // Skip hosts OpenRouter reports as unreliable (GMICloud-class ~18%
            // uptime slips past our own probe when transiently up). null uptime =
            // too new for stats, kept. Threshold is OR's 1-day uptime %.
            const reliableHosts = hosts.filter(
              (h) =>
                (h.uptime == null || h.uptime >= MIN_HOST_UPTIME_PCT) &&
                !SUB_FP8_QUANTIZATIONS.has(
                  (h.quantization ?? "").toLowerCase(),
                ) &&
                !EXCLUDED_HOSTS.has(h.provider.toLowerCase()),
            );
            for (const h of hosts) {
              if (h.uptime != null && h.uptime < MIN_HOST_UPTIME_PCT) {
                consola.warn(
                  t("CORE.OPENROUTER.HOST_LOW_UPTIME", {
                    name,
                    model: r.exposed,
                    host: h.provider,
                    uptime: h.uptime.toFixed(1),
                  }),
                );
              }
            }
            if (reliableHosts.length === 0) continue;
            // The N cheapest reliable hosts, each pinned via provider.only, instead of
            // fanning out a channel per host. Extras are failoverDuplicate so they do not
            // re-enter tier selection: the cheapest sets the published price and the rest
            // only catch the overflow when it is down or rate-limited.
            // Keyed by glob against the exposed name, matching priceAdjustment. Absent
            // key = 1 host, so fanning out stays opt-in per model.
            const hostsWanted =
              Object.entries(providerConfig.hostsPerModel ?? {}).find(
                ([glob]) => matchesAnyPattern(r.exposed, [glob]),
              )?.[1] ?? 1;
            const cheapestHosts = [...reliableHosts]
              .sort((a, b) => a.prompt - b.prompt)
              .slice(0, hostsWanted);
            cheapestHosts.forEach((host, hostIndex) => {
              const m: OfferModel = {
                exposed: r.exposed,
                upstream: reverseMapping[r.exposed] ?? r.upstream,
                modelType: "text",
                testDetail: details.find((d) => d.model === r.upstream),
                upstreamRatio: (host.prompt * 1_000_000) / USD_PER_M_PER_RATIO,
                upstreamCompletionRatio:
                  host.prompt > 0 ? host.completion / host.prompt : 1,
                cacheRatio:
                  host.cacheRead != null && host.prompt > 0
                    ? host.cacheRead / host.prompt
                    : undefined,
                paramOverride: JSON.stringify({
                  provider: { only: [host.provider], allow_fallbacks: false },
                }),
                ...(hostIndex > 0 ? { failoverDuplicate: true } : {}),
              };
              offers.push({
                provider: name,
                providerKind: "openrouter",
                group: `${vendor}-${host.tag}`,
                sanitizedBase: sanitizeGroupName(`${name}-${host.tag}`),
                vendor,
                channelType: CHANNEL_TYPES.OPENROUTER,
                baseUrl: providerConfig.baseUrl,
                apiKey: providerConfig.apiKey,
                groupRatio: markup,
                channelRemark: `OpenRouter ${host.provider} via ${name}`,
                models: [m],
                priceAdjustment: { default: 0 },
                defaultAdjustment: 0,
              });
              totalVendors++;
            });
          }
        };

        emitFreeTier();
        emitPaidPerHost();

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
