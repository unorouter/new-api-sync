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
import { throwIfRunAborted } from "@core/runtime";
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
import { consola } from "consola";
import { colorize } from "consola/utils";
import { partitionByVendor } from "../shared/partition";
import { NewApiClient } from "./client";
import { probeChannelType } from "./probe-channel-type";

function filterGroupModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: ProviderConfig,
  groupName: string,
): string[] {
  let result = models.filter(
    (m) => !matchesBlacklist(m, config.blacklist, providerConfig.name),
  );

  if (providerConfig.enabledVendors?.length) {
    const vendorSet = new Set(
      providerConfig.enabledVendors.map((v) => v.toLowerCase()),
    );
    result = result.filter((m) => {
      const vendor = inferVendorFromModelName(m);
      return vendor && vendorSet.has(vendor);
    });
  }

  const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
  if (enabledGlobs?.length) {
    result = result.filter((m) => matchesAnyPattern(m, enabledGlobs));
  }

  if (config.modelFilter?.length) {
    result = result.filter((m) => matchesAnyPattern(m, config.modelFilter!));
  }

  void groupName;
  return result;
}

/**
 * Build a per-test-model capability hint map (keyed by upstream name, since
 * that's what the test runner sees). For each model, resolve metadata from
 * the external pricing sources using the *exposed* name so model_mapping is
 * applied. Only `supportsTools` and `isReasoning` are forwarded; the runner
 * uses these to skip the tool-call sub-test for reasoning-only models.
 */
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

/**
 * Sanity ceiling for the "all buckets above 1x → keep cheapest" rule.
 * If even the cheapest bucket charges more than this multiple of canonical,
 * we drop the model entirely instead of shipping at the inflated price.
 *
 * Catches upstreams that inflate `model_ratio` for thinking variants
 * (saw 30x for sonnet-thinking, 20x for opus-thinking in real data).
 * Real markups in production data top out around 2x; 3x is a comfortable
 * margin that catches the broken cases without false positives.
 */
const CHEAPEST_FALLBACK_MAX = 3;

/**
 * Per-bucket pre-test decision keyed by `groupName|vendor|upstreamModelName`.
 * The planner builds this once for the whole provider before any HTTP tests
 * fire, then each (group, vendor) bucket consults it to filter its models.
 */
type GateDecisionMap = Map<string, "keep" | "drop">;

const decisionKey = (group: string, vendor: string, upstream: string) =>
  `${group}|${vendor}|${upstream}`;

/**
 * Soft-canonical for the planner gate when voting returned no majority but
 * at least one source matched. Used only for keep/drop decisions, never
 * written to UI. Falls back to the median ratio across all matched sources
 * (with one match, that's just the single hit). Returns undefined when no
 * source matched at all — gate then falls through to "keep all".
 *
 * Why median: with one source we trust it, with multiple disagreeing we
 * pick the dominant cluster's representative without being skewed by an
 * outlier promo or stale list price.
 */
function softCanonical(vote: PricingVoteResult): number | undefined {
  const ratios = vote.candidates
    .map((c) => c.modelRatio)
    .filter((r): r is number => r !== undefined && r > 0);
  if (ratios.length === 0) return undefined;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

/**
 * Build the per-(group, vendor, model) keep/drop decision map for a whole
 * newapi provider in one pass.
 *
 * Decision policy (per exposed model name across all of this provider's
 * (group, vendor) buckets):
 *
 *   1. Resolve a gate canonical: voted cluster first (>= 2 sources agree),
 *      else the median single-source ratio when only one source matched.
 *      Compute predicted charge for every bucket:
 *      charge = canonical * groupRatio * (1 + adjustment) * (upstreamRatio / canonical).
 *
 *   2. If any bucket has charge <= canonical → drop only the buckets above
 *      canonical, keep the at-or-below ones. This is the "normal" case.
 *
 *   3. If every bucket charges above canonical → keep ONLY the cheapest one.
 *      We have no choice but to sell above 1x; pick the least bad option.
 *      (User-visible price will show the actual upstream rate; new-api's
 *      "original price" still surfaces canonical for comparison.)
 *
 *   4. When no source matched at all → keep all buckets (we can't judge),
 *      let normal testing decide.
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
  // For each exposed model, collect candidate buckets with their predicted
  // charge so the policy step can decide keep/drop globally.
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
    /** undefined when no canonical → keep automatically. */
    charge?: number;
    /** undefined when no canonical. */
    canonical?: number;
  }
  const byExposed = new Map<string, BucketCandidate[]>();

  for (const p of opts.prepared) {
    const vendorBuckets = partitionByVendor(
      p.candidateModels,
      (m) => m,
      "unknown",
    );
    for (const [vendor, vendorModels] of vendorBuckets) {
      for (const upstreamName of vendorModels) {
        const exposed = (
          opts.config.modelMapping?.[upstreamName] ?? upstreamName
        ).toLowerCase();
        const modelType = inferModelType(
          exposed,
          undefined,
          opts.localNormalizedEndpoints,
        );
        const adjustment = resolvePriceAdjustment({
          adj: opts.providerConfig.priceAdjustment,
          model: exposed,
          vendor,
          modelType,
          fallback: 0,
          modelMapping: opts.config.modelMapping,
        });
        const upstreamRatio = opts.upstreamPricing.get(upstreamName) ?? 1;
        const vote = resolveCanonicalByVote(
          exposed,
          opts.pricingSources,
          opts.reverseMapping,
        );
        // Voted canonical (>= 2 sources agree) is the strong signal. When
        // voting yields no majority but at least one source matched, fall
        // back to the median single-source ratio for gate decisions only.
        // This catches models present in only one source — e.g.
        // minimax-m2.7-highspeed which basellm carries at $0.6/M but the
        // other 3 sources don't list at all. Without this, the planner
        // can't gate aigc's $9.45/M bucket because vote.cluster is null.
        // Never written to UI as canonical — resolveCanonicalRetail still
        // requires a voted cluster.
        const canonical = vote.cluster?.modelRatio ?? softCanonical(vote);
        // Mirrors processStandardOffer's math:
        //   writtenRatio = canonical (when present)
        //   rescale      = upstreamRatio / writtenRatio
        //   effective    = groupRatio * (1 + adjustment) * rescale
        //   charge       = writtenRatio * effective
        // When canonical is missing we leave charge undefined → "keep".
        let charge: number | undefined;
        if (canonical !== undefined && canonical > 0) {
          const rescale = upstreamRatio / canonical;
          const effective = p.group.ratio * (1 + adjustment) * rescale;
          charge = canonical * effective;
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
    // Record the vote once per exposed model (deduped by recorder).
    const firstWithVote = candidates[0]!;
    recordPricingGate({
      exposed,
      vote: {
        candidates: firstWithVote.vote.candidates.map((c) => {
          const inputUsdPerM =
            c.modelRatio !== undefined ? c.modelRatio * 2 : undefined;
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
              outputUsdPerM:
                firstWithVote.vote.cluster.modelRatio *
                2 *
                firstWithVote.vote.cluster.completionRatio,
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

    const canonical = candidates.find((c) => c.canonical !== undefined)!
      .canonical!;
    const atOrBelow = candidates.filter(
      (c) => c.charge !== undefined && c.charge <= canonical,
    );

    if (atOrBelow.length > 0) {
      // Normal case: drop only above-canonical buckets.
      for (const c of candidates) {
        if (c.charge !== undefined && c.charge > canonical) {
          decisions.set(c.key, "drop");
          consola.info(
            `[pricing] pre-test drop ${exposed} ${opts.providerConfig.name}/${c.group}/${c.vendor} ` +
              `charge=${c.charge.toFixed(3)} ceiling=${canonical.toFixed(3)} ` +
              `(canonical via [${c.vote.cluster?.members.join(",")}], ` +
              `upstream=${c.upstreamRatio.toFixed(3)})`,
          );
        } else {
          decisions.set(c.key, "keep");
        }
      }
      continue;
    }

    // All buckets charge above canonical → keep only the cheapest. We have
    // no source at-or-below 1x, so selling above is the only option; pick
    // the least bad and let new-api show the canonical strikethrough.
    //
    // Hard ceiling: even the cheapest must stay within CHEAPEST_FALLBACK_MAX
    // of canonical, otherwise the upstream is almost certainly broken (e.g.
    // thinking variants where upstream inflates model_ratio 20-30x to
    // capture reasoning-output cost). We refuse to ship those — better no
    // channel than a $90/M Sonnet channel.
    const cheapest = candidates.reduce((min, c) =>
      (c.charge ?? Infinity) < (min.charge ?? Infinity) ? c : min,
    );
    const maxCheapestRatio = cheapest.charge! / canonical;
    if (maxCheapestRatio > CHEAPEST_FALLBACK_MAX) {
      consola.warn(
        `[pricing] all buckets for ${exposed} on ${opts.providerConfig.name} ` +
          `exceed ${CHEAPEST_FALLBACK_MAX}x canonical (cheapest=${cheapest.charge!.toFixed(3)}, ` +
          `canonical=${canonical.toFixed(3)}, ratio=${maxCheapestRatio.toFixed(1)}x); ` +
          `dropping all — upstream pricing looks broken`,
      );
      for (const c of candidates) decisions.set(c.key, "drop");
      continue;
    }
    consola.info(
      `[pricing] all buckets above 1x for ${exposed} on ${opts.providerConfig.name}; ` +
        `keeping cheapest ${cheapest.group}/${cheapest.vendor} ` +
        `(charge=${cheapest.charge!.toFixed(3)}, canonical=${canonical.toFixed(3)})`,
    );
    for (const c of candidates) {
      if (c.key === cheapest.key) {
        decisions.set(c.key, "keep");
      } else {
        decisions.set(c.key, "drop");
        consola.info(
          `[pricing] pre-test drop ${exposed} ${opts.providerConfig.name}/${c.group}/${c.vendor} ` +
            `charge=${c.charge!.toFixed(3)} (above 1x, not cheapest; cheapest kept at ${cheapest.charge!.toFixed(3)})`,
        );
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
  // Per-upstream-name endpoint maps, scoped to this provider only. Compute and
  // emit consume the per-OfferModel `endpoints` / `normalizedEndpoints` fields
  // directly, but inferModelType still wants a Map<string,string[]>.
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
      const vendorSet = new Set(
        providerConfig.enabledVendors.map((v) => v.toLowerCase()),
      );
      groups = groups.filter((g) =>
        g.models.some((m) => {
          const vendor = inferVendorFromModelName(m);
          return vendor && vendorSet.has(vendor);
        }),
      );
    }

    const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
    if (enabledGlobs?.length) {
      groups = groups.filter((g) =>
        g.models.some((m) => matchesAnyPattern(m, enabledGlobs)),
      );
    }

    // Apply global blacklist to groups (by name or description). Text models
    // matching the blacklist are removed; non-text models are unaffected.
    if (config.blacklist?.length) {
      for (const g of groups) {
        const nameHit = matchesBlacklist(
          g.name,
          config.blacklist,
          providerConfig.name,
        );
        const descHit = matchesBlacklist(
          g.description,
          config.blacklist,
          providerConfig.name,
        );
        if (nameHit || descHit) {
          g.models = g.models.filter((m) => inferModelType(m) !== "text");
        }
      }
      groups = groups.filter((g) => g.models.length > 0);
    }

    // Build a flat upstream-name → ratio map from the pricing payload so the
    // pre-test gate can compute charge = writtenRatio * effective without
    // iterating pricing.models on every model.
    const upstreamPricing = new Map<string, number>();
    for (const m of pricing.models) {
      if (typeof m.ratio === "number") upstreamPricing.set(m.name, m.ratio);
    }

    const tokenPrefix = config.target.targetPrefix ?? providerConfig.name;
    const partialSync = (config.modelFilter?.length ?? 0) > 0;
    const tokenResult = await upstream.ensureTokens(groups, tokenPrefix, {
      skipCleanup: partialSync,
    });
    report.tokens = {
      created: tokenResult.created,
      existing: tokenResult.existing,
      deleted: tokenResult.deleted,
    };

    // Track total provider-level cost (start - end balance). Per-model cost
    // tracking has been removed in favor of total-only to unblock multi-
    // threaded testing in the future.
    const startBalance = await upstream.fetchBalance();
    if (startBalance !== null) {
      consola.info(
        `[${providerConfig.name}] Balance: $${startBalance.toFixed(4)}`,
      );
    }

    const groupsWithNoWorkingModels: string[] = [];
    const usedSanitizedNames = new Map<string, number>();

    // Pre-pass: assign deterministic sanitized names per group (sequential
    // because the disambiguator depends on group order). Filter out empty
    // groups here too. Test work below runs in parallel.
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
      if (count > 0) {
        sanitizedName = `${sanitizedName}-${count + 1}`;
      }
      const candidateModels = filterGroupModels(
        group.models,
        config,
        providerConfig,
        group.name,
      );
      if (candidateModels.length === 0) continue;
      const apiKey = tokenResult.tokens[group.name] ?? "";
      prepared.push({
        group,
        originalName,
        sanitizedName,
        candidateModels,
        apiKey,
      });
    }

    // Plan pre-test decisions globally across all (group, vendor) buckets
    // *before* the parallel test loop. This lets the policy reason about
    // every offering of a given model — needed for the "all above 1x → keep
    // cheapest only" rule which can't be decided from a single bucket.
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

    // Fan out: every (group, vendor-bucket) becomes a parallel task. The
    // shared concurrency gate (keyed on baseUrl) ensures we don't exceed
    // perUpstreamConcurrency simultaneous requests against this newapi
    // instance, so opening up the structural loop is safe.
    const groupResults = await Promise.all(
      prepared.map(async (p) => {
        throwIfRunAborted();
        const vendorBuckets = partitionByVendor(
          p.candidateModels,
          (m) => m,
          "unknown",
        );
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
              consola.warn(
                `[${probeLabel}] vendor=${vendor} probe failed; skipping ${vendorModels.length} models`,
              );
              return {
                tested: 0,
                working: 0,
                offer: null as null | UpstreamOffer,
              };
            }

            // Pre-test gate: filter using the precomputed cross-bucket
            // decision map. The planner already logged the why and
            // dedup-recorded the vote; here we just consult the map.
            const gatedModels = gateDecisions
              ? vendorModels.filter(
                  (m) =>
                    gateDecisions.get(decisionKey(p.group.name, vendor, m)) !==
                    "drop",
                )
              : vendorModels;

            if (gatedModels.length === 0) {
              return {
                tested: 0,
                working: 0,
                offer: null as null | UpstreamOffer,
              };
            }

            const capabilities = buildCapabilityMap(
              gatedModels,
              config,
              ctx,
            );

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
              return {
                tested: filterResult.testedCount,
                working: 0,
                offer: null,
              };
            }

            const offerModels: OfferModel[] = workingUpstream.map(
              (upstreamName) => {
                // Exposed names are always lowercase. Other providers reach
                // this via `resolveBareNames` -> `toBareName` which already
                // lowercases; newapi keeps the upstream's group/name model
                // as-is, so we lowercase explicitly here. The original
                // upstream casing is preserved on `upstream` for the
                // channel's model_mapping (newapi expects e.g. CamelCase
                // `MiniMax-M2.5` on outbound requests).
                const exposed = (
                  config.modelMapping?.[upstreamName] ?? upstreamName
                ).toLowerCase();
                const detail = filterResult.details?.find(
                  (d) => d.model === upstreamName,
                );
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
              },
            );

            // Deduplicate by exposed (model_mapping can collapse two
            // upstreams into the same exposed; first occurrence wins).
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
            return {
              tested: filterResult.testedCount,
              working: workingUpstream.length,
              offer,
            };
          }),
        );

        const groupTotalTested = bucketResults.reduce(
          (a, b) => a + b.tested,
          0,
        );
        const groupTotalWorking = bucketResults.reduce(
          (a, b) => a + b.working,
          0,
        );
        const groupOffers = bucketResults
          .map((b) => b.offer)
          .filter((o): o is UpstreamOffer => o !== null);

        if (groupTotalTested > 0) {
          consola.info(
            `[${providerConfig.name}/${p.group.name}] ${groupTotalWorking}/${groupTotalTested} working across ${vendorBuckets.size} vendors`,
          );
        }

        return {
          group: p.group,
          offers: groupOffers,
          hadAnyOffer: groupOffers.length > 0,
        };
      }),
    );

    for (const gr of groupResults) {
      offers.push(...gr.offers);
      if (!gr.hadAnyOffer) {
        groupsWithNoWorkingModels.push(gr.group.name);
      }
    }

    if (!config.isTestMode) {
      await cleanupEmptyGroupTokens(
        upstream,
        groupsWithNoWorkingModels,
        tokenPrefix,
        report,
      );
    }

    if (startBalance !== null) {
      const finalBalance = await upstream.fetchBalance();
      if (finalBalance !== null) {
        const cost = startBalance - finalBalance;
        recordProviderCost(providerConfig.name, cost);
        const costStr =
          cost > 0
            ? ` | Test cost: ${colorize("yellow", `$${cost.toFixed(4)}`)}`
            : "";
        consola.info(
          `[${providerConfig.name}] Balance: $${finalBalance.toFixed(4)}${costStr}`,
        );
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
