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
  predictAboveCanonical,
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
  // Blacklist only applies to text models — image/video/audio/embedding are never blacklisted
  let result = models.filter(
    (m) =>
      inferModelType(m) !== "text" ||
      !matchesBlacklist(m, config.blacklist, providerConfig.name),
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
    const exposed = config.modelMapping?.[upstream] ?? upstream;
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
 * Per-model trace captured during the pre-test gate so testing logs / debug
 * UI can show why a model was dropped (or kept) before any HTTP test fired.
 */
export interface PreTestGateTrace {
  upstream: string;
  exposed: string;
  upstreamRatio: number;
  groupRatio: number;
  adjustment: number;
  vote: PricingVoteResult;
  decision: "kept" | "dropped" | "no-canonical-kept";
  /** Set when decision === "dropped". */
  drop?: {
    canonicalRatio: number;
    effectiveRatio: number;
    charge: number;
    ceiling: number;
  };
}

function applyPreTestCanonicalGate(opts: {
  vendorModels: string[];
  vendor: string;
  providerConfig: ProviderConfig;
  config: RuntimeConfig;
  group: GroupInfo;
  localNormalizedEndpoints: Map<string, string[]>;
  upstreamPricing: Map<string, number>;
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
  /** Output: per-model trace appended for downstream logging. */
  traces: PreTestGateTrace[];
}): string[] {
  const kept: string[] = [];
  const cap = opts.providerConfig.maxRatioCap ?? opts.config.maxRatioCap;

  for (const upstreamName of opts.vendorModels) {
    const exposed = opts.config.modelMapping?.[upstreamName] ?? upstreamName;
    const modelType = inferModelType(
      exposed,
      undefined,
      opts.localNormalizedEndpoints,
    );
    const adjustment = resolvePriceAdjustment({
      adj: opts.providerConfig.priceAdjustment,
      model: exposed,
      vendor: opts.vendor,
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

    const drop = predictAboveCanonical({
      upstreamRatio,
      groupRatio: opts.group.ratio,
      adjustment,
      cap,
      vote,
    });

    const trace: PreTestGateTrace = {
      upstream: upstreamName,
      exposed,
      upstreamRatio,
      groupRatio: opts.group.ratio,
      adjustment,
      vote,
      decision: drop
        ? "dropped"
        : vote.cluster === null
          ? "no-canonical-kept"
          : "kept",
    };

    if (drop) {
      trace.drop = {
        canonicalRatio: drop.canonicalRatio,
        effectiveRatio: drop.effectiveRatio,
        charge: drop.charge,
        ceiling: drop.ceiling,
      };
      consola.info(
        `[pricing] pre-test drop ${exposed} ${opts.providerConfig.name}/${opts.group.name}/${opts.vendor} ` +
          `charge=${drop.charge.toFixed(3)} ceiling=${drop.ceiling.toFixed(3)} ` +
          `(canonical=${drop.canonicalRatio.toFixed(3)} via [${vote.cluster?.members.join(",")}], ` +
          `upstream=${upstreamRatio.toFixed(3)}, cap=${cap})`,
      );
    } else {
      kept.push(upstreamName);
    }

    opts.traces.push(trace);
    recordPricingGate({
      provider: opts.providerConfig.name,
      group: opts.group.name,
      vendor: opts.vendor,
      upstream: upstreamName,
      exposed,
      upstreamRatio,
      groupRatio: opts.group.ratio,
      adjustment,
      decision: trace.decision,
      vote: {
        candidates: vote.candidates,
        cluster: vote.cluster,
        decision: vote.decision,
      },
      drop: trace.drop,
    });

    // Attach the openrouter /endpoints raw rows for THIS model only — keeps
    // the testing log focused on models we actually evaluated rather than
    // dumping all 370 prefetched models. Dedup is handled by the recorder.
    const orHit = vote.candidates.find(
      (c) => c.source === "openrouter" && c.matchedKey,
    );
    if (orHit?.matchedKey) {
      const orTrace = getOpenRouterEndpointsTrace(orHit.matchedKey);
      if (orTrace) recordOpenRouterEndpointsForModel(orTrace);
    }
  }

  return kept;
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

    // Per-(group/vendor/model) trace from the pre-test cap gate. Captured
    // here at the provider level so we can serialize one combined log file
    // per provider after all groups have been processed.
    const gateTraces: PreTestGateTrace[] = [];

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

            // Pre-test gate: drop models whose predicted customer charge
            // (writtenRatio * effective) would exceed canonical * cap. The
            // canonical comes from voting across all 4 pricing sources —
            // this defends against any single source being promo-distorted
            // (e.g. OpenRouter mirrors DeepSeek's 75% off-peak as base price).
            const gatedModels = config.skipUnprofitableText
              ? applyPreTestCanonicalGate({
                  vendorModels,
                  vendor,
                  providerConfig,
                  config,
                  group: p.group,
                  localNormalizedEndpoints,
                  upstreamPricing,
                  pricingSources: ctx.pricingSources,
                  reverseMapping: ctx.reverseMapping,
                  traces: gateTraces,
                })
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
                const exposed =
                  config.modelMapping?.[upstreamName] ?? upstreamName;
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
              maxRatioCap: providerConfig.maxRatioCap ?? config.maxRatioCap,
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
