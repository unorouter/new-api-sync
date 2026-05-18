import { getTaskModelOverride } from "@core/catalog/constants/channel-types";
import {
  parseModelList,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import type { ModelTestDetail } from "@core/testing/types";
import type { MergedModel } from "@core/types";
import { resolvePriceAdjustment } from "./index";
import type { OfferModel, UpstreamOffer } from "./offers";
import { resolveBasePricing, type PricingSource } from "./resolver";
import type {
  BaselineInputs,
  PricedDrop,
  PricedPlan,
  PricedTier,
} from "./types";

interface ComputeArgs {
  offers: UpstreamOffer[];
  baseline: BaselineInputs;
  canonical: Map<string, number>;
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
  modelMapping: Record<string, string>;
}

const PAID_GROUP_RATIO_CANDIDATES = [1, 0.5, 0.25, 0.1, 0.05, 0.01] as const;

const CLAUDE_CONTEXT_1M_SUFFIX = "[1m]";
const CLAUDE_CONTEXT_1M_PATTERN = /^claude-/i;
const CLAUDE_CONTEXT_1M_BETA = "context-1m-2025-08-07";

const CLAUDE_CONTEXT_1M_PARAM_OVERRIDE = JSON.stringify({
  operations: [
    {
      mode: "set_header",
      path: "anthropic-beta",
      value: { $append: [CLAUDE_CONTEXT_1M_BETA] },
      conditions: [
        {
          path: "original_model",
          mode: "suffix",
          value: CLAUDE_CONTEXT_1M_SUFFIX,
        },
      ],
    },
  ],
});

function isAnthropicNativeOffer(offer: UpstreamOffer): boolean {
  return offer.vendor === "anthropic";
}

function shouldAddContext1mAlias(modelName: string): boolean {
  return (
    CLAUDE_CONTEXT_1M_PATTERN.test(modelName) &&
    !modelName.endsWith(CLAUDE_CONTEXT_1M_SUFFIX)
  );
}

function mirrorAliasRatio(
  modelRatios: Map<string, MergedModel>,
  baseName: string,
  aliasName: string,
): void {
  if (modelRatios.has(aliasName)) return;
  const base = modelRatios.get(baseName);
  if (!base) return;
  modelRatios.set(aliasName, { ...base });
}

const bucketKey = (r: number) => Math.round(r * 1e6) / 1e6;
const channelOf = (o: UpstreamOffer) => `${o.sanitizedBase}-${o.vendor}`;
const isFixed = (w: { modelPrice?: number; quotaType?: number }) =>
  (w.modelPrice !== undefined && w.modelPrice > 0) ||
  (w.quotaType !== undefined && w.quotaType >= 1);

const addToBucket = (
  buckets: Map<number, OfferModel[]>,
  key: number,
  m: OfferModel,
): void => {
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = []));
  b.push(m);
};

const adjustmentFor = (
  offer: UpstreamOffer,
  m: OfferModel,
  args: ComputeArgs,
): number =>
  resolvePriceAdjustment({
    adj: offer.priceAdjustment,
    model: m.exposed,
    vendor: offer.vendor,
    modelType: m.modelType,
    fallback: offer.defaultAdjustment,
    modelMapping: args.modelMapping,
  });

export function computePricedPlan(args: ComputeArgs): PricedPlan {
  const { offers, baseline, canonical, pricingSources, reverseMapping } = args;
  const drops: PricedDrop[] = [];
  const tiers: PricedTier[] = [];
  const modelRatios = new Map<string, MergedModel>();
  for (const [name, ratio] of baseline.modelRatios)
    modelRatios.set(name, { ...ratio });

  type Occ = { offer: UpstreamOffer; model: OfferModel };
  const offersByModel = new Map<string, Occ[]>();
  for (const offer of offers)
    for (const m of offer.models) {
      let arr = offersByModel.get(m.exposed);
      if (!arr) offersByModel.set(m.exposed, (arr = []));
      arr.push({ offer, model: m });
    }

  for (const [model, occurrences] of offersByModel) {
    const existing = modelRatios.get(model);
    const fm = occurrences.find((o) => isFixed(o.model))?.model;
    if (fm) {
      modelRatios.set(model, {
        ratio: existing?.ratio ?? 0,
        completionRatio: existing?.completionRatio ?? 0,
        modelPrice: fm.modelPrice ?? existing?.modelPrice,
        quotaType: fm.quotaType ?? existing?.quotaType,
        cacheRatio: existing?.cacheRatio ?? fm.cacheRatio,
        createCacheRatio: existing?.createCacheRatio ?? fm.createCacheRatio,
        imageRatio: existing?.imageRatio,
      });
      continue;
    }

    const canonicalRatio = canonical.get(model);
    const rawSourceHit =
      canonicalRatio !== undefined && pricingSources.length > 0
        ? resolveBasePricing(model, pricingSources, reverseMapping)
        : undefined;
    const sourceHit =
      rawSourceHit !== undefined &&
      canonicalRatio !== undefined &&
      Math.abs(rawSourceHit.modelRatio - canonicalRatio) < 1e-6
        ? rawSourceHit
        : undefined;

    let co: OfferModel | undefined;
    for (const occ of occurrences) {
      const om = occ.model;
      if (om.isFree || om.upstreamRatio === undefined) continue;
      if (co === undefined || om.upstreamRatio < co.upstreamRatio!) co = om;
    }

    let writtenRatio: number;
    let completionRatio: number;
    let cacheRatio: number | undefined;
    let createCacheRatio: number | undefined;
    if (sourceHit) {
      writtenRatio = sourceHit.modelRatio;
      completionRatio = sourceHit.completionRatio;
      cacheRatio = sourceHit.cacheRatio;
      createCacheRatio = sourceHit.createCacheRatio;
    } else if (canonicalRatio !== undefined || co) {
      writtenRatio = canonicalRatio ?? co!.upstreamRatio!;
      completionRatio = co?.upstreamCompletionRatio ?? 1;
      cacheRatio = co?.cacheRatio;
      createCacheRatio = co?.createCacheRatio;
    } else {
      if (existing) continue;
      const allFree = occurrences.every((o) => o.model.isFree);
      writtenRatio = allFree ? 0 : 1;
      completionRatio = allFree ? 0 : 1;
    }

    modelRatios.set(model, {
      ratio: writtenRatio,
      completionRatio,
      cacheRatio: cacheRatio ?? existing?.cacheRatio,
      createCacheRatio: createCacheRatio ?? existing?.createCacheRatio,
      modelPrice: existing?.modelPrice,
      quotaType: existing?.quotaType,
      imageRatio: existing?.imageRatio,
    });
  }

  const phaseAOffers: UpstreamOffer[] = [];
  const phaseBOffers: UpstreamOffer[] = [];
  const hasAny = (m: OfferModel) =>
    m.upstreamRatio !== undefined ||
    m.isFree ||
    (m.modelPrice !== undefined && m.modelPrice >= 0) ||
    (m.quotaType !== undefined && m.quotaType >= 1);
  for (const offer of offers) {
    const forceA =
      offer.paidTier ||
      offer.providerKind === "openrouter" ||
      offer.providerKind === "nvidia";
    (forceA || offer.models.some(hasAny) ? phaseAOffers : phaseBOffers).push(
      offer,
    );
  }

  for (const offer of phaseAOffers)
    if (offer.paidTier)
      processPaidOffer(offer, modelRatios, canonical, tiers, drops);
    else processStandardOffer(offer, modelRatios, args, tiers);

  const cheapestForPhaseB = buildBaselineCheapestMap(baseline);
  for (const tier of tiers) {
    if (tier.groupRatio < 0) continue;
    for (const m of tier.models) {
      const cur = cheapestForPhaseB.get(m);
      if (cur === undefined || tier.groupRatio < cur)
        cheapestForPhaseB.set(m, tier.groupRatio);
    }
  }
  for (const offer of phaseBOffers)
    processNoUpstreamOffer(
      offer,
      modelRatios,
      canonical,
      cheapestForPhaseB,
      args,
      tiers,
      drops,
    );
  return { tiers, modelRatios, drops };
}

function processStandardOffer(
  offer: UpstreamOffer,
  modelRatios: Map<string, MergedModel>,
  args: ComputeArgs,
  tiers: PricedTier[],
): void {
  const buckets = new Map<number, OfferModel[]>();
  for (const m of offer.models) {
    const written = modelRatios.get(m.exposed);
    if (!written) continue;
    let groupRatio: number;
    if (m.isFree) groupRatio = 0;
    else {
      const base = offer.groupRatio * (1 + adjustmentFor(offer, m, args));
      groupRatio =
        !isFixed(written) && m.upstreamRatio !== undefined && written.ratio > 0
          ? base * (m.upstreamRatio / written.ratio)
          : base;
    }
    addToBucket(buckets, bucketKey(groupRatio), m);
  }
  if (buckets.size > 0) pushBucketsAsTiers(offer, buckets, tiers, modelRatios);
}

function processPaidOffer(
  offer: UpstreamOffer,
  modelRatios: Map<string, MergedModel>,
  canonical: Map<string, number>,
  tiers: PricedTier[],
  drops: PricedDrop[],
): void {
  let chosen: { ratio: number; kept: OfferModel[] } | null = null;
  for (const candidate of PAID_GROUP_RATIO_CANDIDATES) {
    const kept = offer.models.filter((m) => {
      const ratio = modelRatios.get(m.exposed)?.ratio ?? 1;
      const ceiling = canonical.get(m.exposed) ?? ratio;
      return ratio * candidate <= ceiling;
    });
    if (kept.length === offer.models.length) {
      chosen = { ratio: candidate, kept };
      break;
    }
    if (kept.length > 0 && !chosen) chosen = { ratio: candidate, kept };
  }

  const channel = channelOf(offer);
  if (!chosen || chosen.kept.length === 0) {
    for (const m of offer.models)
      drops.push({
        model: m.exposed,
        channel,
        reason: "no-fit",
        detail: "no group_ratio candidate fits within canonical",
      });
    return;
  }
  const keptSet = new Set(chosen.kept);
  for (const m of offer.models)
    if (!keptSet.has(m))
      drops.push({
        model: m.exposed,
        channel,
        reason: "cap-exceeded",
        effectiveRatio: chosen.ratio,
        detail: `at chosen group_ratio=${chosen.ratio}`,
      });
  pushBucketsAsTiers(
    offer,
    new Map([[chosen.ratio, chosen.kept]]),
    tiers,
    modelRatios,
  );
}

function processNoUpstreamOffer(
  offer: UpstreamOffer,
  modelRatios: Map<string, MergedModel>,
  canonical: Map<string, number>,
  cheapestForModel: Map<string, number>,
  args: ComputeArgs,
  tiers: PricedTier[],
  drops: PricedDrop[],
): void {
  const buckets = new Map<number, OfferModel[]>();
  const channel = channelOf(offer);
  for (const m of offer.models) {
    const adj = adjustmentFor(offer, m, args);
    const cheapest = cheapestForModel.get(m.exposed) ?? offer.groupRatio;
    const groupRatio = cheapest * (1 + adj);
    if (groupRatio > 1) {
      const written = modelRatios.get(m.exposed)?.ratio ?? 1;
      const ceiling = canonical.get(m.exposed) ?? written;
      if (written * groupRatio > ceiling) {
        drops.push({
          model: m.exposed,
          channel,
          reason: "cap-exceeded",
          effectiveRatio: groupRatio,
        });
        continue;
      }
    }
    addToBucket(buckets, bucketKey(groupRatio), m);
  }
  if (buckets.size > 0) pushBucketsAsTiers(offer, buckets, tiers, modelRatios);
}

function pushBucketsAsTiers(
  offer: UpstreamOffer,
  buckets: Map<number, OfferModel[]>,
  tiers: PricedTier[],
  modelRatios: Map<string, MergedModel>,
): void {
  type Sub = {
    models: OfferModel[];
    channelType?: number;
    baseUrlSuffix?: string;
  };
  const baseUrlTrim = offer.baseUrl.replace(/\/$/, "");
  const groupDesc = `${sanitizeGroupName(offer.group)} via ${offer.provider} (${offer.vendor})`;
  let tierIdx = 0;
  for (const [groupRatio, bucketModels] of buckets) {
    const subGroups = new Map<string, Sub>();
    for (const m of bucketModels) {
      const override =
        !m.endpoints || m.endpoints.includes("openai-video")
          ? getTaskModelOverride(m.exposed)
          : undefined;
      const key = override
        ? `${override.channelType}:${override.baseUrlSuffix ?? ""}`
        : "default";
      let entry = subGroups.get(key);
      if (!entry) subGroups.set(key, (entry = { models: [], ...override }));
      entry.models.push(m);
    }
    let subIdx = 0;
    for (const [, sub] of subGroups) {
      const tierSuffix =
        buckets.size > 1 || subGroups.size > 1
          ? `-t${tierIdx}${subGroups.size > 1 ? String.fromCharCode(97 + subIdx) : ""}`
          : "";
      const tierModelMapping: Record<string, string> = {};
      const tierDetails: ModelTestDetail[] = [];
      for (const m of sub.models) {
        if (m.exposed !== m.upstream) tierModelMapping[m.exposed] = m.upstream;
        if (m.testDetail) tierDetails.push(m.testDetail);
      }

      const tierModels = sub.models.map((m) => m.exposed);
      let hasContext1mAlias = false;
      if (isAnthropicNativeOffer(offer)) {
        for (const m of sub.models) {
          if (!shouldAddContext1mAlias(m.exposed)) continue;
          const alias = `${m.exposed}${CLAUDE_CONTEXT_1M_SUFFIX}`;
          tierModels.push(alias);
          tierModelMapping[alias] = m.upstream;
          mirrorAliasRatio(modelRatios, m.exposed, alias);
          hasContext1mAlias = true;
        }
      }

      tiers.push({
        channelName: `${offer.sanitizedBase}-${offer.vendor}${tierSuffix}`,
        vendor: offer.vendor,
        channelType: sub.channelType ?? offer.channelType,
        baseUrl: baseUrlTrim + (sub.baseUrlSuffix ?? ""),
        apiKey: offer.apiKey,
        providerTag: offer.provider,
        channelRemark: offer.channelRemark,
        groupRatio,
        groupDescription: groupDesc,
        models: tierModels,
        modelMapping: Object.keys(tierModelMapping).length
          ? tierModelMapping
          : undefined,
        testDetails: tierDetails.length ? tierDetails : undefined,
        paramOverride: hasContext1mAlias
          ? CLAUDE_CONTEXT_1M_PARAM_OVERRIDE
          : undefined,
      });
      subIdx++;
    }
    tierIdx++;
  }
}

function buildBaselineCheapestMap(
  baseline: BaselineInputs,
): Map<string, number> {
  const groupRatioByName = new Map(
    baseline.groups.map((g) => [g.name, g.ratio]),
  );
  const cheapest = new Map<string, number>();
  for (const ch of baseline.channels) {
    const gRatio = groupRatioByName.get(ch.group) ?? 1;
    for (const m of parseModelList(ch.models)) {
      const cur = cheapest.get(m);
      if (cur === undefined || gRatio < cur) cheapest.set(m, gRatio);
    }
  }
  return cheapest;
}
