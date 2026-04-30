import {
  getEnabledModelGlobs,
  getTestModelTypes,
  type RuntimeConfig,
} from "@core/config";
import { normalizeEndpointTypes } from "@core/models/constants/endpoints";
import { inferModelType } from "@core/models/constants/inference";
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
import type {
  EndpointPathInfo,
  OfferModel,
  ProviderResult,
  UpstreamOffer,
} from "@core/pricing/offers";
import { throwIfRunAborted } from "@core/runtime/abort";
import type { GroupInfo, ProviderReport } from "@core/types";
import type { ProviderConfig } from "@core/validations/config";
import { consola } from "consola";
import { colorize } from "consola/utils";
import { NewApiClient } from "./client";
import { probeChannelType } from "./probe-channel-type";

/**
 * Partition a flat model list into vendor buckets. Models without a known
 * vendor matcher land in `unknown` so they still get a channel.
 */
function partitionByVendor(models: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const model of models) {
    const vendor = inferVendorFromModelName(model) ?? "unknown";
    if (!out.has(vendor)) out.set(vendor, []);
    out.get(vendor)!.push(model);
  }
  return out;
}

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

    // Pull this upstream's per-model ratios from pricing.models. Used by
    // compute() to rescale tier group_ratios.
    const upstreamModelRatios = new Map<string, number>();
    for (const model of pricing.models) {
      if (model.ratio > 0) upstreamModelRatios.set(model.name, model.ratio);
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
        const vendorBuckets = partitionByVendor(p.candidateModels);
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
              return { tested: 0, working: 0, offer: null as null | UpstreamOffer };
            }

            const filterResult = await testAndFilterModels({
              allModels: vendorModels,
              baseUrl: providerConfig.baseUrl,
              apiKey: p.apiKey,
              channelType: probe.channelType,
              providerLabel: `${probeLabel}/${vendor}`,
              testableModelTypes: getTestModelTypes(config, providerConfig),
              modelEndpoints: localNormalizedEndpoints,
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

    void upstreamModelRatios; // exported via offer.models[].upstreamRatio
    report.groups = groups.length;
    report.models = pricing.models.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  return { report, offers, endpointMetadata: { endpointPaths } };
}
