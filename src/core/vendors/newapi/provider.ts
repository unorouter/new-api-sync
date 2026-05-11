import { normalizeEndpointTypes } from "@core/catalog/constants/endpoints";
import { inferModelType } from "@core/catalog/constants/inference";
import {
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import {
  getEnabledModelGlobs,
  getTestModelTypes,
  type RuntimeConfig,
} from "@core/config";
import { resolvePriceAdjustment } from "@core/pricing/index";
import type {
  EndpointPathInfo,
  OfferModel,
  ProviderResult,
  UpstreamOffer,
} from "@core/pricing/offers";
import {
  resolveSourceMetadata,
  type PricingSource,
} from "@core/pricing/resolver";
import {
  resolveCanonicalByVote,
  type PricingVoteResult,
} from "@core/pricing/vote";
import { throwIfRunAborted } from "@core/infra/abort";
import {
  recordOpenRouterEndpointsForModel,
  recordPricingGate,
  recordProviderCost,
  testAndFilterModels,
  type ModelCapabilityHint,
} from "@core/testing/runner";
import { getOpenRouterEndpointsTrace } from "@core/pricing/sources/openrouter";
import type { GroupInfo, ProviderReport } from "@core/types";
import type { ProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { colorize } from "consola/utils";
import {
  buildCapabilityMap,
  lowercaseExposed,
} from "../shared/capability-map";
import { partitionByVendor } from "../shared/partition";
import { NewApiClient } from "./client";
import { probeChannelType } from "./probe-channel-type";

function filterGroupModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: ProviderConfig,
): string[] {
  let result = models.filter((m) => !matchesBlacklist(m, config.blacklist, providerConfig.name));
  if (providerConfig.enabledVendors?.length) {
    const vendorSet = new Set(providerConfig.enabledVendors.map((v) => v.toLowerCase()));
    result = result.filter((m) => {
      const vendor = inferVendorFromModelName(m);
      return vendor && vendorSet.has(vendor);
    });
  }
  const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
  if (enabledGlobs?.length) result = result.filter((m) => matchesAnyPattern(m, enabledGlobs));
  if (config.modelFilter?.length) result = result.filter((m) => matchesAnyPattern(m, config.modelFilter!));
  return result;
}

/** Sanity ceiling for "all buckets above 1x → keep cheapest"; caught real 20-30x thinking-variant markups. */
const CHEAPEST_FALLBACK_MAX = 3;

/** keyed by `groupName|vendor|upstreamModelName`. Built once per provider, consumed per (group, vendor). */
type GateDecisionMap = Map<string, "keep" | "drop">;

const decisionKey = (group: string, vendor: string, upstream: string) =>
  `${group}|${vendor}|${upstream}`;

/** Gate-only median (never UI-canonical). Returns undefined → "keep all". */
function softCanonical(vote: PricingVoteResult): number | undefined {
  const ratios = vote.candidates
    .map((c) => c.modelRatio)
    .filter((r): r is number => r !== undefined && r > 0);
  if (ratios.length === 0) return undefined;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

/**
 * Per-(group, vendor, exposed) keep/drop. charge = canonical * groupRatio * (1+adj) * (upstreamRatio/canonical).
 * Any bucket ≤ canonical → drop above-canonical only. All above → keep cheapest. No source match → keep all.
 */
function planPreTestDecisions(opts: {
  prepared: Array<{
    group: GroupInfo;
    candidateModels: string[];
  }>;
  providerConfig: ProviderConfig;
  config: RuntimeConfig;
  upstreamPricing: Map<string, number>;
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
  localNormalizedEndpoints: Map<string, string[]>;
}): GateDecisionMap {
  interface BucketCandidate {
    key: string;
    group: string;
    vendor: string;
    upstream: string;
    exposed: string;
    upstreamRatio: number;
    groupRatio: number;
    adjustment: number;
    vote: PricingVoteResult;
    /** Undefined → keep automatically. */
    charge?: number;
    canonical?: number;
  }
  const byExposed = new Map<string, BucketCandidate[]>();

  for (const p of opts.prepared) {
    const vendorBuckets = partitionByVendor(p.candidateModels, (m) => m, "unknown");
    for (const [vendor, vendorModels] of vendorBuckets) {
      for (const upstreamName of vendorModels) {
        const exposed = (opts.config.modelMapping?.[upstreamName] ?? upstreamName).toLowerCase();
        const modelType = inferModelType(exposed, undefined, opts.localNormalizedEndpoints);
        const adjustment = resolvePriceAdjustment({
          adj: opts.providerConfig.priceAdjustment,
          model: exposed,
          vendor,
          modelType,
          fallback: 0,
          modelMapping: opts.config.modelMapping,
        });
        const upstreamRatio = opts.upstreamPricing.get(upstreamName) ?? 1;
        const vote = resolveCanonicalByVote(exposed, opts.pricingSources, opts.reverseMapping);
        // Vote cluster strong; softCanonical for single-source matches.
        const canonical = vote.cluster?.modelRatio ?? softCanonical(vote);
        let charge: number | undefined;
        if (canonical !== undefined && canonical > 0) {
          charge = canonical * (p.group.ratio * (1 + adjustment) * (upstreamRatio / canonical));
        }
        const cand: BucketCandidate = {
          key: decisionKey(p.group.name, vendor, upstreamName),
          group: p.group.name,
          vendor,
          upstream: upstreamName,
          exposed,
          upstreamRatio,
          groupRatio: p.group.ratio,
          adjustment,
          vote,
          charge,
          canonical,
        };
        let bucket = byExposed.get(exposed);
        if (!bucket) {
          bucket = [];
          byExposed.set(exposed, bucket);
        }
        bucket.push(cand);
      }
    }
  }

  const decisions: GateDecisionMap = new Map();

  for (const [exposed, candidates] of byExposed) {
    const firstWithVote = candidates[0]!;
    recordPricingGate({
      exposed,
      vote: {
        candidates: firstWithVote.vote.candidates.map((c) => {
          const inputUsdPerM = c.modelRatio !== undefined ? c.modelRatio * 2 : undefined;
          const outputUsdPerM =
            inputUsdPerM !== undefined && c.completionRatio !== undefined
              ? inputUsdPerM * c.completionRatio
              : undefined;
          return { ...c, inputUsdPerM, outputUsdPerM };
        }),
        cluster: firstWithVote.vote.cluster
          ? {
              ...firstWithVote.vote.cluster,
              inputUsdPerM: firstWithVote.vote.cluster.modelRatio * 2,
              outputUsdPerM: firstWithVote.vote.cluster.modelRatio * 2 * firstWithVote.vote.cluster.completionRatio,
            }
          : null,
        decision: firstWithVote.vote.decision,
      },
    });
    const orHit = firstWithVote.vote.candidates.find(
      (c) => c.source === "openrouter" && c.matchedKey,
    );
    if (orHit?.matchedKey) {
      const orTrace = getOpenRouterEndpointsTrace(orHit.matchedKey);
      if (orTrace) recordOpenRouterEndpointsForModel(orTrace);
    }

    // No canonical → keep everything for this model.
    const haveCanonical = candidates.some((c) => c.charge !== undefined);
    if (!haveCanonical) {
      for (const c of candidates) decisions.set(c.key, "keep");
      continue;
    }

    const canonical = candidates.find((c) => c.canonical !== undefined)!.canonical!;
    const atOrBelow = candidates.filter((c) => c.charge !== undefined && c.charge <= canonical);

    if (atOrBelow.length > 0) {
      for (const c of candidates) {
        if (c.charge !== undefined && c.charge > canonical) {
          decisions.set(c.key, "drop");
          consola.info(t("CORE.PRICING.PRE_TEST_DROP", {
            model: exposed,
            provider: opts.providerConfig.name,
            group: c.group,
            vendor: c.vendor,
            charge: c.charge.toFixed(3),
            ceiling: canonical.toFixed(3),
            members: c.vote.cluster?.members.join(",") ?? "",
            upstream: c.upstreamRatio.toFixed(3),
          }));
        } else {
          decisions.set(c.key, "keep");
        }
      }
      continue;
    }

    // All above canonical → cheapest only, subject to CHEAPEST_FALLBACK_MAX ceiling.
    const cheapest = candidates.reduce((min, c) => (c.charge ?? Infinity) < (min.charge ?? Infinity) ? c : min);
    const maxCheapestRatio = cheapest.charge! / canonical;
    if (maxCheapestRatio > CHEAPEST_FALLBACK_MAX) {
      consola.warn(t("CORE.PRICING.ALL_BUCKETS_BROKEN", {
        model: exposed,
        provider: opts.providerConfig.name,
        limit: CHEAPEST_FALLBACK_MAX,
        cheapest: cheapest.charge!.toFixed(3),
        canonical: canonical.toFixed(3),
        ratio: maxCheapestRatio.toFixed(1),
      }));
      for (const c of candidates) decisions.set(c.key, "drop");
      continue;
    }
    consola.info(t("CORE.PRICING.ALL_BUCKETS_ABOVE_KEEP_CHEAPEST", {
      model: exposed,
      provider: opts.providerConfig.name,
      group: cheapest.group,
      vendor: cheapest.vendor,
      charge: cheapest.charge!.toFixed(3),
      canonical: canonical.toFixed(3),
    }));
    for (const c of candidates) {
      if (c.key === cheapest.key) {
        decisions.set(c.key, "keep");
      } else {
        decisions.set(c.key, "drop");
        consola.info(t("CORE.PRICING.PRE_TEST_DROP_NOT_CHEAPEST", {
          model: exposed,
          provider: opts.providerConfig.name,
          group: c.group,
          vendor: c.vendor,
          charge: c.charge!.toFixed(3),
          cheapest: cheapest.charge!.toFixed(3),
        }));
      }
    }
  }

  return decisions;
}

async function cleanupEmptyGroupTokens(
  upstream: NewApiClient,
  groupNames: string[],
  tokenPrefix: string,
  report: ProviderReport,
): Promise<void> {
  if (groupNames.length === 0) return;
  const allTokens = await upstream.listTokens();
  for (const groupName of groupNames) {
    const tokenName = `${groupName}-${tokenPrefix}`;
    const token = allTokens.find((t) => t.name === tokenName);
    if (token && (await upstream.deleteToken(token.id))) {
      report.tokens.deleted++;
    }
  }
}

export async function processNewApiProvider(
  providerConfig: ProviderConfig,
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
  const endpointPaths = new Map<string, EndpointPathInfo>();
  // inferModelType still expects Map<string,string[]>; offers/compute use the per-model fields.
  const localNormalizedEndpoints = new Map<string, string[]>();

  try {
    const upstream = new NewApiClient(providerConfig, providerConfig.name);

    const pricing = await upstream.fetchPricing();

    for (const model of pricing.models) {
      if (model.supportedEndpoints?.length) {
        localNormalizedEndpoints.set(
          model.name,
          normalizeEndpointTypes(model.supportedEndpoints),
        );
      }
    }
    for (const [ep, info] of Object.entries(pricing.endpointPaths)) {
      endpointPaths.set(ep, info);
    }

    let groups: GroupInfo[] = pricing.groups;

    if (providerConfig.enabledVendors?.length) {
      const vendorSet = new Set(providerConfig.enabledVendors.map((v) => v.toLowerCase()));
      groups = groups.filter((g) => g.models.some((m) => {
        const vendor = inferVendorFromModelName(m);
        return vendor && vendorSet.has(vendor);
      }));
    }

    const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
    if (enabledGlobs?.length) {
      groups = groups.filter((g) => g.models.some((m) => matchesAnyPattern(m, enabledGlobs)));
    }

    // Global blacklist applies to text only.
    if (config.blacklist?.length) {
      for (const g of groups) {
        const nameHit = matchesBlacklist(g.name, config.blacklist, providerConfig.name);
        const descHit = matchesBlacklist(g.description, config.blacklist, providerConfig.name);
        if (nameHit || descHit) g.models = g.models.filter((m) => inferModelType(m) !== "text");
      }
      groups = groups.filter((g) => g.models.length > 0);
    }

    // upstream-name → ratio for the pre-test gate.
    const upstreamPricing = new Map<string, number>();
    for (const m of pricing.models) {
      if (typeof m.ratio === "number") upstreamPricing.set(m.name, m.ratio);
    }

    const tokenPrefix = config.target.targetPrefix ?? providerConfig.name;
    const partialSync = (config.modelFilter?.length ?? 0) > 0;
    const tokenResult = await upstream.ensureTokens(groups, tokenPrefix, { skipCleanup: partialSync });
    report.tokens = {
      created: tokenResult.created,
      existing: tokenResult.existing,
      deleted: tokenResult.deleted,
    };

    const startBalance = await upstream.fetchBalance();
    if (startBalance !== null) {
      consola.info(t("CORE.PROVIDER.BALANCE", { name: providerConfig.name, amount: startBalance.toFixed(4) }));
    }

    const groupsWithNoWorkingModels: string[] = [];
    const usedSanitizedNames = new Map<string, number>();

    // Sequential pre-pass (disambiguator depends on group order). Tests below run in parallel.
    type Prepared = {
      group: (typeof groups)[number];
      originalName: string;
      sanitizedName: string;
      candidateModels: string[];
      apiKey: string;
    };
    const prepared: Prepared[] = [];
    for (const group of groups) {
      const originalName = `${group.name}-${providerConfig.name}`;
      let sanitizedName = sanitizeGroupName(originalName);
      const count = usedSanitizedNames.get(sanitizedName) ?? 0;
      usedSanitizedNames.set(sanitizedName, count + 1);
      if (count > 0) sanitizedName = `${sanitizedName}-${count + 1}`;
      const candidateModels = filterGroupModels(group.models, config, providerConfig);
      if (candidateModels.length === 0) continue;
      const apiKey = tokenResult.tokens[group.name] ?? "";
      prepared.push({ group, originalName, sanitizedName, candidateModels, apiKey });
    }

    // Global pre-test decisions before the parallel loop (the "all above 1x → cheapest" rule needs cross-bucket vision).
    const gateDecisions = config.skipUnprofitableText
      ? planPreTestDecisions({
          prepared,
          providerConfig,
          config,
          upstreamPricing,
          pricingSources: ctx.pricingSources,
          reverseMapping: ctx.reverseMapping,
          localNormalizedEndpoints,
        })
      : null;

    // ConcurrencyGate (keyed on baseUrl) enforces perUpstreamConcurrency.
    const groupResults = await Promise.all(
      prepared.map(async (p) => {
        throwIfRunAborted();
        const vendorBuckets = partitionByVendor(p.candidateModels, (m) => m, "unknown");
        const probeLabel = `${providerConfig.name}/${p.group.name}`;

        const bucketResults = await Promise.all(
          [...vendorBuckets.entries()].map(async ([vendor, vendorModels]) => {
            throwIfRunAborted();
            const probe = await probeChannelType({
              baseUrl: providerConfig.baseUrl,
              apiKey: p.apiKey,
              vendor,
              models: vendorModels,
              modelEndpoints: localNormalizedEndpoints,
              logPrefix: probeLabel,
            });
            if (!probe) {
              consola.warn(t("CORE.PROVIDER.PROBE_FAILED_SKIP", {
                label: probeLabel,
                vendor,
                count: vendorModels.length,
              }));
              return { tested: 0, working: 0, offer: null as null | UpstreamOffer };
            }

            const gatedModels = gateDecisions
              ? vendorModels.filter((m) => gateDecisions.get(decisionKey(p.group.name, vendor, m)) !== "drop")
              : vendorModels;
            if (gatedModels.length === 0) {
              return { tested: 0, working: 0, offer: null as null | UpstreamOffer };
            }

            const capabilities = buildCapabilityMap(gatedModels, lowercaseExposed(config), ctx);
            const filterResult = await testAndFilterModels({
              allModels: gatedModels,
              baseUrl: providerConfig.baseUrl,
              apiKey: p.apiKey,
              channelType: probe.channelType,
              providerLabel: `${probeLabel}/${vendor}`,
              testableModelTypes: getTestModelTypes(config, providerConfig),
              modelEndpoints: localNormalizedEndpoints,
              capabilities,
            });

            const workingUpstream = filterResult.workingModels;
            if (workingUpstream.length === 0) {
              return { tested: filterResult.testedCount, working: 0, offer: null };
            }

            const offerModels: OfferModel[] = workingUpstream.map((upstreamName) => {
              // Lowercase exposed; upstream preserves casing (newapi expects CamelCase outbound).
              const exposed = (config.modelMapping?.[upstreamName] ?? upstreamName).toLowerCase();
              const detail = filterResult.details?.find((d) => d.model === upstreamName);
              const normalized = localNormalizedEndpoints.get(upstreamName);
              const mt = inferModelType(exposed, normalized);
              const m = pricing.models.find((pm) => pm.name === upstreamName);
              return {
                exposed,
                upstream: upstreamName,
                modelType: mt,
                upstreamRatio: m?.ratio,
                upstreamCompletionRatio: m?.completionRatio,
                cacheRatio: m?.cacheRatio,
                createCacheRatio: m?.createCacheRatio,
                modelPrice: m?.modelPrice,
                quotaType: m?.quotaType,
                endpoints: m?.supportedEndpoints,
                normalizedEndpoints: normalized,
                testDetail: detail,
              };
            });

            // Dedup by exposed (model_mapping can collapse multiple upstreams; first wins).
            const seen = new Set<string>();
            const dedupedOfferModels: OfferModel[] = [];
            for (const om of offerModels) {
              if (seen.has(om.exposed)) continue;
              seen.add(om.exposed);
              dedupedOfferModels.push(om);
            }

            const offer: UpstreamOffer = {
              provider: providerConfig.name,
              providerKind: "newapi",
              group: p.group.name,
              sanitizedBase: p.sanitizedName,
              vendor,
              channelType: probe.channelType,
              baseUrl: providerConfig.baseUrl,
              apiKey: p.apiKey,
              groupRatio: p.group.ratio,
              channelRemark: p.originalName,
              models: dedupedOfferModels,
              priceAdjustment: providerConfig.priceAdjustment,
              defaultAdjustment: 0,
            };
            return { tested: filterResult.testedCount, working: workingUpstream.length, offer };
          }),
        );

        const groupTotalTested = bucketResults.reduce((a, b) => a + b.tested, 0);
        const groupTotalWorking = bucketResults.reduce((a, b) => a + b.working, 0);
        const groupOffers = bucketResults.map((b) => b.offer).filter((o): o is UpstreamOffer => o !== null);

        if (groupTotalTested > 0) {
          consola.info(t("CORE.PROVIDER.WORKING_ACROSS_VENDORS", {
            provider: providerConfig.name,
            group: p.group.name,
            working: groupTotalWorking,
            total: groupTotalTested,
            vendors: vendorBuckets.size,
          }));
        }

        return { group: p.group, offers: groupOffers, hadAnyOffer: groupOffers.length > 0 };
      }),
    );

    for (const gr of groupResults) {
      offers.push(...gr.offers);
      if (!gr.hadAnyOffer) groupsWithNoWorkingModels.push(gr.group.name);
    }

    if (!config.isTestMode) {
      await cleanupEmptyGroupTokens(upstream, groupsWithNoWorkingModels, tokenPrefix, report);
    }

    if (startBalance !== null) {
      const finalBalance = await upstream.fetchBalance();
      if (finalBalance !== null) {
        const cost = startBalance - finalBalance;
        recordProviderCost(providerConfig.name, cost);
        consola.info(cost > 0
          ? t("CORE.PROVIDER.BALANCE_WITH_COST", {
              name: providerConfig.name,
              amount: finalBalance.toFixed(4),
              cost: colorize("yellow", `$${cost.toFixed(4)}`),
            })
          : t("CORE.PROVIDER.BALANCE", { name: providerConfig.name, amount: finalBalance.toFixed(4) }));
      }
    }

    report.groups = groups.length;
    report.models = pricing.models.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  return { report, offers, endpointMetadata: { endpointPaths } };
}
