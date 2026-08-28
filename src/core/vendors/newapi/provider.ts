import { normalizeEndpointTypes } from "@core/catalog/constants/endpoints";
import { inferModelType } from "@core/catalog/constants/inference";
import {
  dedupBase,
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { toBareName } from "@core/catalog/bare-name";
import {
  getEnabledModelGlobs,
  getTestModelTypes,
  type RuntimeConfig,
} from "@core/config";
import {
  applyPriceAdjustment,
  resolvePriceAdjustment,
} from "@core/pricing/index";
import { isFixed } from "@core/pricing/compute";
import { imagePerCallUsd, isPerTokenImage } from "@core/pricing/image-per-call";
import type {
  EndpointPathInfo,
  OfferModel,
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import type { PricingSource } from "@core/pricing/sources/types";
import { effectiveRatioFromBillingExpr } from "@core/pricing/tiered-expr";
import {
  resolveCanonicalByVote,
  type PricingVoteResult,
} from "@core/pricing/vote";
import { throwIfRunAborted } from "@core/infra/abort";
import {
  recordOpenRouterEndpointsForModel,
  recordPricingGate,
  recordProviderCost,
  screenDroppedClaudeAuthenticity,
  testAndFilterModels,
} from "@core/testing/runner";
import { getOpenRouterEndpointsTrace } from "@core/pricing/sources/openrouter";
import type { GroupInfo, ProviderReport } from "@core/types";
import type { ProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { colorize } from "consola/utils";
import { buildCapabilityMap, lowercaseExposed } from "../shared/capability-map";
import { partitionByVendor } from "../shared/partition";
import { NewApiClient } from "./client";
import { nativeShapeForVendor, probeChannelType } from "./probe-channel-type";

// Parse failure -> placeholder ratio -> silent "no-fit" drop. Warn once/model so it's diagnosable.
const warnedBadBillingExpr = new Set<string>();
function effectiveTieredOrWarn(billingExpr: string, modelName: string) {
  const effective = effectiveRatioFromBillingExpr(billingExpr);
  if (effective === undefined && !warnedBadBillingExpr.has(modelName)) {
    warnedBadBillingExpr.add(modelName);
    consola.warn(
      `Unparseable billing_expr for "${modelName}", likely dropped: ${billingExpr}`,
    );
  }
  return effective;
}

function filterGroupModels(
  models: string[],
  config: RuntimeConfig,
  pc: ProviderConfig,
  modelEndpoints?: Map<string, string[]>,
): string[] {
  let r = models.filter((m) => !matchesBlacklist(m, config.blacklist, pc.name));
  const enabledGlobs = getEnabledModelGlobs(pc.enabledModels);
  if (enabledGlobs?.length)
    r = r.filter((m) => matchesAnyPattern(m, enabledGlobs));
  if (config.modelFilter?.length)
    r = r.filter((m) => matchesAnyPattern(m, config.modelFilter!));
  if (config.modelTypeFilter?.length) {
    const types = new Set(config.modelTypeFilter);
    r = r.filter((m) =>
      types.has(inferModelType(m, undefined, modelEndpoints)),
    );
  }
  return r;
}

const CHEAPEST_FALLBACK_MAX = 3;
// "drop-noscreen": dropped AND exempt from the dropped-claude authenticity screen.
// Screening probes bill at the group's real ratio, so a far-over-canonical group
// (claudemax_x5 at 500x) burns real money verifying a lane that can never serve.
const SCREEN_DROPPED_MAX = 2;
type GateDecisionMap = Map<string, "keep" | "drop" | "drop-noscreen">;

function softCanonical(vote: PricingVoteResult): number | undefined {
  const ratios = vote.candidates
    .map((c) => c.modelRatio)
    .filter((r): r is number => r !== undefined && r > 0);
  if (ratios.length === 0) return undefined;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

// prettier-ignore
type BucketCandidate = { key: string; group: string; vendor: string; upstream: string; exposed: string; upstreamRatio: number; groupRatio: number; adjustment: number; vote: PricingVoteResult; charge?: number; canonical?: number; isMedia: boolean };

function planPreTestDecisions(opts: {
  prepared: Array<{ group: GroupInfo; candidateModels: string[] }>;
  providerConfig: ProviderConfig;
  config: RuntimeConfig;
  upstreamPricing: Map<string, number>;
  upstreamCompletionRatios: Map<string, number>;
  upstreamFixed: Map<string, boolean>;
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
  localNormalizedEndpoints: Map<string, string[]>;
  // Must be the SAME resolver the emit path uses: the gate keys canonical lookup
  // and priceAdjustment globs off this name, so a divergence prices one name and
  // publishes another.
  exposedNameFor: (upstreamName: string) => string;
}): GateDecisionMap {
  const byExposed = new Map<string, BucketCandidate[]>();
  const pName = opts.providerConfig.name;
  for (const p of opts.prepared) {
    for (const [vendor, vendorModels] of partitionByVendor(
      p.candidateModels,
      (m) => m,
      "unknown",
    )) {
      for (const upstreamName of vendorModels) {
        const exposed = opts.exposedNameFor(upstreamName);
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
        const rawCanonical = vote.cluster?.modelRatio ?? softCanonical(vote);
        // Per-token image/media models cost ~modelRatio*completionRatio*imageTokens, not modelRatio
        // alone. For those, price a representative generation in ACTUAL $/call (modelRatio*2 == $/M)
        // on BOTH the cost and canonical sides, so charge/canonical is dimensionless and the drop
        // log reads real cents. Text/per-request models stay in plain modelRatio space.
        const perTokenImage = isPerTokenImage(
          modelType,
          opts.upstreamFixed.get(upstreamName) ?? false,
        );
        const completionRatio =
          opts.upstreamCompletionRatios.get(upstreamName) ?? 1;
        const costRatio = perTokenImage
          ? imagePerCallUsd({ modelRatio: upstreamRatio, completionRatio })
          : upstreamRatio;
        const canonical =
          perTokenImage && rawCanonical !== undefined
            ? imagePerCallUsd({
                modelRatio: rawCanonical,
                completionRatio: vote.cluster?.completionRatio ?? 1,
              })
            : rawCanonical;
        const charge =
          canonical !== undefined && canonical > 0
            ? applyPriceAdjustment(
                p.group.ratio * costRatio,
                adjustment,
                canonical,
              )
            : undefined;
        if (perTokenImage && canonical !== undefined && charge !== undefined) {
          consola.debug(
            t("CORE.PRICING.PER_TOKEN_IMAGE_COST", {
              model: exposed,
              provider: pName,
              group: p.group.name,
              vendor,
              cost: costRatio.toFixed(4),
              modelRatio: upstreamRatio.toFixed(3),
              completionRatio: completionRatio.toFixed(2),
              canonical: canonical.toFixed(4),
              canonicalRatio: (rawCanonical ?? 0).toFixed(3),
              canonicalComp: (vote.cluster?.completionRatio ?? 1).toFixed(2),
              charge: charge.toFixed(4),
            }),
          );
        }
        let bucket = byExposed.get(exposed);
        if (!bucket) byExposed.set(exposed, (bucket = []));
        bucket.push({
          key: `${p.group.name}|${vendor}|${upstreamName}`,
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
          isMedia: modelType !== "text",
        });
      }
    }
  }

  const decisions: GateDecisionMap = new Map();
  for (const [exposed, candidates] of byExposed) {
    const first = candidates[0]!;
    const vc = first.vote.cluster;
    const usd = (mr?: number, cr?: number) => ({
      inputUsdPerM: mr !== undefined ? mr * 2 : undefined,
      outputUsdPerM:
        mr !== undefined && cr !== undefined ? mr * 2 * cr : undefined,
    });
    recordPricingGate({
      exposed,
      vote: {
        candidates: first.vote.candidates.map((c) => ({
          ...c,
          ...usd(c.modelRatio, c.completionRatio),
        })),
        cluster: vc
          ? {
              ...vc,
              inputUsdPerM: vc.modelRatio * 2,
              outputUsdPerM: vc.modelRatio * 2 * vc.completionRatio,
            }
          : null,
        decision: first.vote.decision,
      },
    });
    const orHit = first.vote.candidates.find(
      (c) => c.source === "openrouter" && c.matchedKey,
    );
    if (orHit?.matchedKey) {
      const tr = getOpenRouterEndpointsTrace(orHit.matchedKey);
      if (tr) recordOpenRouterEndpointsForModel(tr);
    }
    if (!candidates.some((c) => c.charge !== undefined)) {
      for (const c of candidates) decisions.set(c.key, "keep");
      continue;
    }
    const canonical = candidates.find(
      (c) => c.canonical !== undefined,
    )!.canonical!;
    const atOrBelow = candidates.filter(
      (c) => c.charge !== undefined && c.charge <= canonical,
    );
    if (atOrBelow.length > 0) {
      for (const c of candidates) {
        if (c.charge !== undefined && c.charge > canonical) {
          decisions.set(
            c.key,
            c.charge <= canonical * SCREEN_DROPPED_MAX
              ? "drop"
              : "drop-noscreen",
          );
          consola.info(
            t("CORE.PRICING.PRE_TEST_DROP", {
              model: exposed,
              provider: pName,
              group: c.group,
              vendor: c.vendor,
              charge: c.charge.toFixed(3),
              ceiling: canonical.toFixed(3),
              members: c.vote.cluster?.members.join(",") ?? "",
              upstream: c.upstreamRatio.toFixed(3),
            }),
          );
        } else decisions.set(c.key, "keep");
      }
      continue;
    }
    const cheapest = candidates.reduce((min, c) =>
      (c.charge ?? Infinity) < (min.charge ?? Infinity) ? c : min,
    );
    const ratio = cheapest.charge! / canonical;
    // Media (image/video/audio) is never dropped wholesale for exceeding canonical: there are few
    // providers and no free fallback, so always keep the single cheapest even above the limit.
    // Text still drops all when the cheapest is > CHEAPEST_FALLBACK_MAX (likely broken upstream).
    if (ratio > CHEAPEST_FALLBACK_MAX && !cheapest.isMedia) {
      consola.warn(
        t("CORE.PRICING.ALL_BUCKETS_BROKEN", {
          model: exposed,
          provider: pName,
          limit: CHEAPEST_FALLBACK_MAX,
          cheapest: cheapest.charge!.toFixed(3),
          canonical: canonical.toFixed(3),
          ratio: ratio.toFixed(1),
        }),
      );
      for (const c of candidates)
        decisions.set(
          c.key,
          (c.charge ?? Infinity) <= canonical * SCREEN_DROPPED_MAX
            ? "drop"
            : "drop-noscreen",
        );
      continue;
    }
    consola.info(
      t("CORE.PRICING.ALL_BUCKETS_ABOVE_KEEP_CHEAPEST", {
        model: exposed,
        provider: pName,
        group: cheapest.group,
        vendor: cheapest.vendor,
        charge: cheapest.charge!.toFixed(3),
        canonical: canonical.toFixed(3),
      }),
    );
    for (const c of candidates) {
      if (c.key === cheapest.key) {
        decisions.set(c.key, "keep");
        continue;
      }
      decisions.set(
        c.key,
        c.charge! <= canonical * SCREEN_DROPPED_MAX ? "drop" : "drop-noscreen",
      );
      consola.info(
        t("CORE.PRICING.PRE_TEST_DROP_NOT_CHEAPEST", {
          model: exposed,
          provider: pName,
          group: c.group,
          vendor: c.vendor,
          charge: c.charge!.toFixed(3),
          cheapest: cheapest.charge!.toFixed(3),
        }),
      );
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
    const token = allTokens.find(
      (t) => t.name === `${groupName}-${tokenPrefix}`,
    );
    if (token && (await upstream.deleteToken(token.id)))
      report.tokens.deleted++;
  }
}

export async function processNewApiProvider(
  providerConfig: ProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): Promise<ProviderResult> {
  const pName = providerConfig.name;
  const baseUrl = providerConfig.baseUrl;
  const report: ProviderReport = {
    name: pName,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  const endpointPaths = new Map<string, EndpointPathInfo>();
  const localNormalizedEndpoints = new Map<string, string[]>();
  try {
    const upstream = new NewApiClient(providerConfig, pName);
    const pricing = await upstream.fetchPricing();
    const pricingByName = new Map(pricing.models.map((m) => [m.name, m]));
    // Relays publish vendor-prefixed ids ("openai/gpt-oss-20b"). Publish the bare
    // name like every other provider kind, EXCEPT where the same bare name maps to
    // more than one upstream id in this provider's catalog: trp1 serves a free
    // "z-ai/glm-5.2" alongside a paid "glm-5.2", so collapsing them would sell the
    // paid lane under the free name. Counted over the WHOLE catalog, not the
    // per-vendor working set, so a twin in another bucket still blocks the strip.
    const bareNameCounts = new Map<string, number>();
    for (const m of pricing.models) {
      const bare = toBareName(m.name);
      bareNameCounts.set(bare, (bareNameCounts.get(bare) ?? 0) + 1);
    }
    const exposedNameFor = (upstreamName: string): string => {
      const mapped = config.modelMapping?.[upstreamName];
      if (mapped !== undefined) return mapped.toLowerCase();
      const bare = toBareName(upstreamName);
      return (
        bareNameCounts.get(bare) === 1 ? bare : upstreamName
      ).toLowerCase();
    };
    for (const m of pricing.models) {
      if (m.supportedEndpoints?.length)
        localNormalizedEndpoints.set(
          m.name,
          normalizeEndpointTypes(m.supportedEndpoints),
        );
    }
    for (const [ep, info] of Object.entries(pricing.endpointPaths))
      endpointPaths.set(ep, info);
    let groups: GroupInfo[] = pricing.groups;
    const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
    if (enabledGlobs?.length)
      groups = groups.filter((g) =>
        g.models.some((m) => matchesAnyPattern(m, enabledGlobs)),
      );
    if (config.blacklist?.length) {
      for (const g of groups) {
        if (
          matchesBlacklist(g.name, config.blacklist, pName) ||
          matchesBlacklist(g.description, config.blacklist, pName)
        )
          g.models = g.models.filter((m) => inferModelType(m) !== "text");
      }
      groups = groups.filter((g) => g.models.length > 0);
    }
    const upstreamPricing = new Map<string, number>();
    for (const m of pricing.models) {
      // Tiered models ship a placeholder model_ratio (often 37.5) that would
      // trip the canonical cap. Derive the effective input ratio from the
      // DEAREST tier's `p` coefficient (same units as model_ratio), which is
      // what effectiveRatioFromBillingExpr defaults to. Dearest, not cheapest:
      // one published price has to cover every request, and a long-context call
      // billed at the cheap tier's rate loses money on the difference.
      const effective = m.billingExpr
        ? effectiveTieredOrWarn(m.billingExpr, m.name)
        : undefined;
      if (effective !== undefined)
        upstreamPricing.set(m.name, effective.modelRatio);
      else if (typeof m.ratio === "number")
        upstreamPricing.set(m.name, m.ratio);
    }
    // Completion ratios feed the cap's per-token image cost estimate (imagePerCallUsd).
    const upstreamCompletionRatios = new Map<string, number>();
    for (const m of pricing.models)
      if (typeof m.completionRatio === "number")
        upstreamCompletionRatios.set(m.name, m.completionRatio);
    // Per-request (fixed) vs per-token, so the cap only USD-estimates true per-token image models.
    const upstreamFixed = new Map<string, boolean>();
    for (const m of pricing.models)
      upstreamFixed.set(
        m.name,
        isFixed({ modelPrice: m.modelPrice, quotaType: m.quotaType }),
      );
    const tokenPrefix = config.target.targetPrefix ?? pName;
    const partialSync = (config.modelFilter?.length ?? 0) > 0;
    // Dry-run creates no upstream tokens and reads no balance (both cost/mutate);
    // probes + tests are skipped downstream so the per-group apiKey is unused.
    const tokenResult = ctx.dryRun
      ? {
          tokens: {} as Record<string, string>,
          created: 0,
          existing: 0,
          deleted: 0,
        }
      : await upstream.ensureTokens(groups, tokenPrefix, {
          skipCleanup: partialSync,
        });
    report.tokens = {
      created: tokenResult.created,
      existing: tokenResult.existing,
      deleted: tokenResult.deleted,
    };
    const startBalance = ctx.dryRun ? null : await upstream.fetchBalance();
    if (startBalance !== null)
      consola.info(
        t("CORE.PROVIDER.BALANCE", {
          name: pName,
          amount: startBalance.toFixed(4),
        }),
      );
    const groupsWithNoWorkingModels: string[] = [];
    const usedSanitizedNames = new Map<string, number>();
    type Prepared = {
      group: (typeof groups)[number];
      originalName: string;
      sanitizedName: string;
      candidateModels: string[];
      apiKey: string;
    };
    const prepared: Prepared[] = [];
    for (const group of groups) {
      const originalName = `${group.name}-${pName}`;
      const sanitizedName = dedupBase(
        sanitizeGroupName(originalName),
        usedSanitizedNames,
      );
      const candidateModels = filterGroupModels(
        group.models,
        config,
        providerConfig,
        localNormalizedEndpoints,
      );
      if (candidateModels.length === 0) continue;
      prepared.push({
        group,
        originalName,
        sanitizedName,
        candidateModels,
        apiKey: tokenResult.tokens[group.name] ?? "",
      });
    }
    const gateDecisions = config.skipUnprofitableText
      ? planPreTestDecisions({
          prepared,
          providerConfig,
          config,
          upstreamPricing,
          upstreamCompletionRatios,
          upstreamFixed,
          pricingSources: ctx.pricingSources,
          reverseMapping: ctx.reverseMapping,
          localNormalizedEndpoints,
          exposedNameFor,
        })
      : null;
    const groupResults = await Promise.all(
      prepared.map(async (p) => {
        throwIfRunAborted();
        const vendorBuckets = partitionByVendor(
          p.candidateModels,
          (m) => m,
          "unknown",
        );
        const probeLabel = `${pName}/${p.group.name}`;
        const bucketResults = await Promise.all(
          [...vendorBuckets.entries()].map(async ([vendor, vendorModels]) => {
            throwIfRunAborted();
            // Dry-run: no upstream probe (costs nothing); assume the vendor's
            // native channel shape.
            const probe = ctx.dryRun
              ? {
                  channelType: nativeShapeForVendor(vendor),
                  shape: "native" as const,
                }
              : await probeChannelType({
                  baseUrl,
                  apiKey: p.apiKey,
                  vendor,
                  models: vendorModels,
                  modelEndpoints: localNormalizedEndpoints,
                  logPrefix: probeLabel,
                  accept429: providerConfig.acceptRateLimited,
                  acceptUpstreamDown: providerConfig.acceptUpstreamDown,
                });
            if (!probe) {
              consola.warn(
                t("CORE.PROVIDER.PROBE_FAILED_SKIP", {
                  label: probeLabel,
                  vendor,
                  count: vendorModels.length,
                }),
              );
              return {
                tested: 0,
                working: 0,
                offer: null as null | UpstreamOffer,
              };
            }
            const gatedModels = gateDecisions
              ? vendorModels.filter(
                  (m) =>
                    !gateDecisions
                      .get(`${p.group.name}|${vendor}|${m}`)
                      ?.startsWith("drop"),
                )
              : vendorModels;
            const droppedModels = gateDecisions
              ? vendorModels.filter(
                  (m) =>
                    gateDecisions.get(`${p.group.name}|${vendor}|${m}`) ===
                    "drop",
                )
              : [];
            if (droppedModels.length > 0 && !ctx.dryRun)
              await screenDroppedClaudeAuthenticity({
                baseUrl,
                apiKey: p.apiKey,
                models: droppedModels,
                channelType: probe.channelType,
                prefix: `${probeLabel}/${vendor}`,
              });
            if (gatedModels.length === 0)
              return {
                tested: 0,
                working: 0,
                offer: null as null | UpstreamOffer,
              };
            // Dry-run: no live tests (the money). Every gate-kept model is
            // treated as working so pricing + diff compute against the full set.
            // upstreamDown behaves the same way for a different reason: the host
            // is not answering, so testing every model would just buy the same
            // timeout N more times.
            const filterResult =
              ctx.dryRun || probe.upstreamDown
                ? {
                    workingModels: gatedModels,
                    testedCount: 0,
                    rateLimitedModels: [] as string[],
                    details: undefined,
                  }
                : await testAndFilterModels({
                    allModels: gatedModels,
                    baseUrl,
                    apiKey: p.apiKey,
                    channelType: probe.channelType,
                    providerLabel: `${probeLabel}/${vendor}`,
                    testableModelTypes: getTestModelTypes(
                      config,
                      providerConfig,
                    ),
                    modelEndpoints: localNormalizedEndpoints,
                    acceptRateLimited: providerConfig.acceptRateLimited,
                    capabilities: buildCapabilityMap(
                      gatedModels,
                      lowercaseExposed(config),
                      ctx,
                    ),
                  });
            const workingUpstream = filterResult.workingModels;
            if (workingUpstream.length === 0)
              return {
                tested: filterResult.testedCount,
                working: 0,
                offer: null,
              };
            const seen = new Set<string>();
            const rateLimitedSet = new Set(filterResult.rateLimitedModels);
            const dedupedOfferModels: OfferModel[] = [];
            for (const upstreamName of workingUpstream) {
              const exposed = exposedNameFor(upstreamName);
              if (seen.has(exposed)) continue;
              seen.add(exposed);
              const normalized = localNormalizedEndpoints.get(upstreamName);
              const m = pricingByName.get(upstreamName);
              const modelType = inferModelType(exposed, normalized);
              // Replace placeholder ratios with effective values from the
              // billing expression so downstream cap/canonical checks compare
              // in the same units.
              const tieredEff = m?.billingExpr
                ? effectiveTieredOrWarn(m.billingExpr, upstreamName)
                : undefined;
              // A relay model priced at zero (ratio 0 AND no per-call price) is a
              // genuine free lane: mark it so the pricing engine emits groupRatio 0
              // and publishes it as `{name}:free`, not a bare paid-looking name.
              const effRatio = tieredEff?.modelRatio ?? m?.ratio;
              const isFree =
                effRatio === 0 && (m?.modelPrice ?? 0) === 0 ? true : undefined;
              dedupedOfferModels.push({
                exposed,
                upstream: upstreamName,
                modelType,
                ...(isFree ? { isFree: true } : {}),
                ...(rateLimitedSet.has(upstreamName)
                  ? { rateLimited: true }
                  : {}),
                upstreamRatio: tieredEff?.modelRatio ?? m?.ratio,
                upstreamCompletionRatio:
                  tieredEff?.completionRatio ?? m?.completionRatio,
                cacheRatio: tieredEff?.cacheRatio ?? m?.cacheRatio,
                createCacheRatio:
                  tieredEff?.createCacheRatio ?? m?.createCacheRatio,
                modelPrice: m?.modelPrice,
                quotaType: m?.quotaType,
                endpoints: m?.supportedEndpoints,
                normalizedEndpoints: normalized,
                audioRatio: m?.audioRatio,
                audioCompletionRatio: m?.audioCompletionRatio,
                imageRatio: m?.imageRatio,
                gridRows: m?.gridRows,
                billingMode: m?.billingMode,
                billingExpr: m?.billingExpr,
                pricingVersion: m?.pricingVersion,
                testDetail: filterResult.details?.find(
                  (d) => d.model === upstreamName,
                ),
              });
            }
            const offer: UpstreamOffer = {
              provider: pName,
              providerKind: "newapi",
              group: p.group.name,
              sanitizedBase: p.sanitizedName,
              vendor,
              channelType: probe.channelType,
              baseUrl,
              apiKey: p.apiKey,
              groupRatio: p.group.ratio,
              channelRemark: p.originalName,
              models: dedupedOfferModels,
              priceAdjustment: providerConfig.priceAdjustment,
              defaultAdjustment: 0,
              ...(probe.upstreamDown ? { upstreamDown: true } : {}),
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
        if (groupTotalTested > 0)
          consola.info(
            t("CORE.PROVIDER.WORKING_ACROSS_VENDORS", {
              provider: pName,
              group: p.group.name,
              working: groupTotalWorking,
              total: groupTotalTested,
              vendors: vendorBuckets.size,
            }),
          );
        return {
          group: p.group,
          offers: groupOffers,
          hadAnyOffer: groupOffers.length > 0,
        };
      }),
    );
    for (const gr of groupResults) {
      offers.push(...gr.offers);
      if (!gr.hadAnyOffer) groupsWithNoWorkingModels.push(gr.group.name);
    }
    // NEVER under a model/type filter: a filtered run tests only the matching
    // models, so a healthy group whose models are all out of scope produces
    // zero offers and reads as "empty" - deleting its upstream token then
    // 401-kills every out-of-scope channel still carrying that key (live
    // incident: a mimo-only fishx run deleted china-prod/default-prod and
    // auto-disabled all 30 glm/kimi/deepseek lanes).
    if (!config.isTestMode && !config.modelFilter && !config.modelTypeFilter)
      await cleanupEmptyGroupTokens(
        upstream,
        groupsWithNoWorkingModels,
        tokenPrefix,
        report,
      );
    if (startBalance !== null) {
      const finalBalance = await upstream.fetchBalance();
      if (finalBalance !== null) {
        const cost = startBalance - finalBalance;
        recordProviderCost(pName, cost);
        const amount = finalBalance.toFixed(4);
        consola.info(
          cost > 0
            ? t("CORE.PROVIDER.BALANCE_WITH_COST", {
                name: pName,
                amount,
                cost: colorize("yellow", `$${cost.toFixed(4)}`),
              })
            : t("CORE.PROVIDER.BALANCE", { name: pName, amount }),
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
