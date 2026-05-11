// computePricedPlan: pure function. All pricing math lives here.
//
// Given a flat list of UpstreamOffer (across all providers) plus canonical
// retail ratios, baseline channels/groups, and model mapping, produce a
// PricedPlan: priced tiers ready to emit, the global model_ratios map, and
// any per-(model, channel) drops.
//
// No I/O, no SyncState mutation. Ordering of offers in the input list does
// not affect the output (other than which "cheapest" wins when offers tie
// on a deterministic key).
//
// The math (single source of truth):
//
//   adjustment = resolvePriceAdjustment(offer.priceAdjustment, model, vendor, type, defaultAdjustment, modelMapping)
//
//   written_ratio = canonical[model] if canonical resolves
//                   else cheapest upstream_ratio across offers serving model
//                   else 1 (fallback for sub2api with no canonical)
//
//   For each (offer, model):
//     if model.isFree:
//         tier_group_ratio = 0; skip cap; skip rescale.
//     elif model.modelPrice > 0 or model.quotaType >= 1:
//         tier_group_ratio = offer.groupRatio * (1 + adjustment); written_ratio
//         carries modelPrice/quotaType through unchanged.
//     elif model.upstreamRatio is defined:
//         rescale = model.upstreamRatio / written_ratio
//         tier_group_ratio = offer.groupRatio * (1 + adjustment) * rescale
//     else:  # sub2api
//         tier_group_ratio = cheapest_existing_group_ratio_for(model) * (1 + adjustment)
//
//     # Cap (only if tier_group_ratio > 1)
//     charge = written_ratio * tier_group_ratio
//     ceiling = (canonical[model] ?? written_ratio) * cap
//     if charge > ceiling: drop (model, offer)
//
// Paid OpenRouter offers (paidTier=true) bypass the per-model rescale: the
// loop instead picks one shared group_ratio per (offer.provider, vendor)
// from candidates [1, 0.5, 0.25, 0.1, 0.05, 0.01] such that every model
// fits under cap. Models that don't fit at any candidate are dropped.
//
// Channel naming inside compute (so emit can stay dumb):
//   sanitizedBase + "-" + vendor                (single tier, no override)
//   sanitizedBase + "-" + vendor + "-tN"        (multiple tiers)
//   sanitizedBase + "-" + vendor + "-tNa"       (multiple sub-tiers from task overrides)

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
import type { BaselineInputs, PricedDrop, PricedPlan, PricedTier } from "./types";

export interface ComputeArgs {
  offers: UpstreamOffer[];
  baseline: BaselineInputs;
  /** Pre-resolved canonical retail ratios (LiteLLM > OpenRouter > basellm).
   *  Keys are the exposed model names. */
  canonical: Map<string, number>;
  /** Pricing sources kept available to backfill completion / cache ratios
   *  for canonical-overridden models. */
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
  modelMapping: Record<string, string>;
}

const PAID_GROUP_RATIO_CANDIDATES = [1, 0.5, 0.25, 0.1, 0.05, 0.01] as const;

interface RescaleContext {
  writtenRatio: number;
  canonical?: number;
  completionRatio: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  modelPrice?: number;
  quotaType?: number;
}

export function computePricedPlan(args: ComputeArgs): PricedPlan {
  const { offers, baseline, canonical, pricingSources, reverseMapping } = args;

  const drops: PricedDrop[] = [];
  const tiers: PricedTier[] = [];

  // ─── Step 1: build the global model_ratios map ─────────────────────────
  // canonical wins; else cheapest upstream_ratio across paid non-fixed offers;
  // free → ratio=0; fixed-price preserves modelPrice/quotaType.

  const modelRatios = new Map<string, MergedModel>();

  // baseline seeded first for partial-sync semantics.
  for (const [name, ratio] of baseline.modelRatios) {
    modelRatios.set(name, { ...ratio });
  }

  const offersByModel = new Map<string, Array<{ offer: UpstreamOffer; model: OfferModel }>>();
  for (const offer of offers) {
    for (const m of offer.models) {
      let arr = offersByModel.get(m.exposed);
      if (!arr) {
        arr = [];
        offersByModel.set(m.exposed, arr);
      }
      arr.push({ offer, model: m });
    }
  }

  // Use resolveBasePricing (fuzzy) so completion/cache fields stay consistent with canonical.
  for (const [model, occurrences] of offersByModel) {
    // Any offer with modelPrice>0 or quotaType>=1 forces the fixed-price path.
    const fixedOffer = occurrences.find(
      (o) =>
        (o.model.modelPrice !== undefined && o.model.modelPrice > 0) ||
        (o.model.quotaType !== undefined && o.model.quotaType >= 1),
    );
    if (fixedOffer) {
      const m = fixedOffer.model;
      const existing = modelRatios.get(model);
      modelRatios.set(model, {
        ratio: existing?.ratio ?? 0,
        completionRatio: existing?.completionRatio ?? 0,
        modelPrice: m.modelPrice ?? existing?.modelPrice,
        quotaType: m.quotaType ?? existing?.quotaType,
        cacheRatio: existing?.cacheRatio ?? m.cacheRatio,
        createCacheRatio: existing?.createCacheRatio ?? m.createCacheRatio,
        imageRatio: existing?.imageRatio,
      });
      continue;
    }

    // Free models still flow through canonical so the UI can render "original price" struck-through.
    const canonicalRatio = canonical.get(model);
    // sourceHit only contributes completion/cache when its ratio matches canonical (else canonical was substituted past an outlier).
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

    // Paid non-free contribute to cheapest.
    let cheapestOffer: { offer: UpstreamOffer; model: OfferModel } | undefined;
    for (const occ of occurrences) {
      if (occ.model.isFree) continue;
      if (occ.model.upstreamRatio === undefined) continue;
      if (
        cheapestOffer === undefined ||
        (occ.model.upstreamRatio ?? Infinity) <
          (cheapestOffer.model.upstreamRatio ?? Infinity)
      ) {
        cheapestOffer = occ;
      }
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
    } else if (canonicalRatio !== undefined) {
      writtenRatio = canonicalRatio;
      completionRatio =
        cheapestOffer?.model.upstreamCompletionRatio ?? 1;
      cacheRatio = cheapestOffer?.model.cacheRatio;
      createCacheRatio = cheapestOffer?.model.createCacheRatio;
    } else if (cheapestOffer) {
      writtenRatio = cheapestOffer.model.upstreamRatio!;
      completionRatio = cheapestOffer.model.upstreamCompletionRatio ?? 1;
      cacheRatio = cheapestOffer.model.cacheRatio;
      createCacheRatio = cheapestOffer.model.createCacheRatio;
    } else {
      // No canonical, no paid upstream. Keep baseline; else all-free → 0/0, else 1/1 fallback.
      const existing = modelRatios.get(model);
      if (existing) continue;
      const allFree = occurrences.every((o) => o.model.isFree);
      writtenRatio = allFree ? 0 : 1;
      completionRatio = allFree ? 0 : 1;
    }

    // Preserve cache fields from baseline if new sources don't carry them.
    const existing = modelRatios.get(model);
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

  // ─── Step 2: rescale formula → PricedTier per offer ─────────────────────

  const baselineCheapestGroupForModel = buildBaselineCheapestMap(baseline);

  // Phase A: independent ratios (free/paid/upstream-priced).
  // Phase B: needs cheapest-across-baseline+A lookup (sub2api).
  const phaseAOffers: UpstreamOffer[] = [];
  const phaseBOffers: UpstreamOffer[] = [];
  for (const offer of offers) {
    // OpenRouter (paid → ladder, free → isFree=0), NVIDIA (free/fixed): always phase A.
    if (offer.paidTier || offer.providerKind === "openrouter" || offer.providerKind === "nvidia") {
      phaseAOffers.push(offer);
      continue;
    }
    const hasUpstream = offer.models.some(
      (m) =>
        m.upstreamRatio !== undefined ||
        m.isFree ||
        (m.modelPrice !== undefined && m.modelPrice >= 0) ||
        (m.quotaType !== undefined && m.quotaType >= 1),
    );
    if (hasUpstream) phaseAOffers.push(offer);
    else phaseBOffers.push(offer);
  }

  for (const offer of phaseAOffers) {
    if (offer.paidTier) {
      processPaidOffer(offer, modelRatios, canonical, tiers, drops);
    } else {
      processStandardOffer(offer, modelRatios, canonical, args, tiers, drops);
    }
  }

  // Cumulative cheapest-group across baseline + phase A; consumed by sub2api lookups.
  const cheapestForPhaseB = new Map(baselineCheapestGroupForModel);
  for (const tier of tiers) {
    if (tier.groupRatio < 0) continue;
    for (const m of tier.models) {
      const cur = cheapestForPhaseB.get(m);
      if (cur === undefined || tier.groupRatio < cur) {
        cheapestForPhaseB.set(m, tier.groupRatio);
      }
    }
  }

  // sub2api: one tier per (offer, distinct group_ratio).
  for (const offer of phaseBOffers) {
    processNoUpstreamOffer(
      offer,
      modelRatios,
      canonical,
      cheapestForPhaseB,
      args,
      tiers,
      drops,
    );
  }

  return { tiers, modelRatios, drops };
}

// ─── Standard (newapi, openrouter free, nvidia) ────────────────────────────

function processStandardOffer(
  offer: UpstreamOffer,
  modelRatios: Map<string, MergedModel>,
  canonical: Map<string, number>,
  args: ComputeArgs,
  tiers: PricedTier[],
  _drops: PricedDrop[],
): void {
  // Bucket models by effective ratio (1e6-rounded for stable keys).
  const buckets = new Map<number, OfferModel[]>();
  for (const m of offer.models) {
    const written = modelRatios.get(m.exposed);
    if (!written) {
      // Should never happen if Step 1 ran for every model; defensive skip.
      continue;
    }
    const ctx: RescaleContext = {
      writtenRatio: written.ratio,
      canonical: canonical.get(m.exposed),
      completionRatio: written.completionRatio,
      cacheRatio: written.cacheRatio,
      createCacheRatio: written.createCacheRatio,
      modelPrice: written.modelPrice,
      quotaType: written.quotaType,
    };
    const groupRatio = computeStandardGroupRatio(offer, m, ctx, args);
    if (groupRatio === undefined) continue;

    // Cap check lives in the pre-test planner (newapi/provider.ts); re-applying here would silently drop cheapest-fallback survivors.
    const key = Math.round(groupRatio * 1e6) / 1e6;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(m);
  }

  if (buckets.size === 0) return;

  pushBucketsAsTiers(offer, buckets, tiers);
}

function computeStandardGroupRatio(
  offer: UpstreamOffer,
  m: OfferModel,
  ctx: RescaleContext,
  args: ComputeArgs,
): number | undefined {
  if (m.isFree) return 0;

  const adjustment = resolvePriceAdjustment({
    adj: offer.priceAdjustment,
    model: m.exposed,
    vendor: offer.vendor,
    modelType: m.modelType,
    fallback: offer.defaultAdjustment,
    modelMapping: args.modelMapping,
  });

  // Fixed-price: group_ratio still scales modelPrice.
  if (
    (ctx.modelPrice !== undefined && ctx.modelPrice > 0) ||
    (ctx.quotaType !== undefined && ctx.quotaType >= 1)
  ) {
    return offer.groupRatio * (1 + adjustment);
  }

  // Standard rescale.
  if (m.upstreamRatio !== undefined && ctx.writtenRatio > 0) {
    const rescale = m.upstreamRatio / ctx.writtenRatio;
    return offer.groupRatio * (1 + adjustment) * rescale;
  }
  // Defensive: shouldn't hit (phase B handles no-upstream).
  return offer.groupRatio * (1 + adjustment);
}

// ─── Paid OpenRouter: pick one ladder candidate per vendor ──────────────────

function processPaidOffer(
  offer: UpstreamOffer,
  modelRatios: Map<string, MergedModel>,
  canonical: Map<string, number>,
  tiers: PricedTier[],
  drops: PricedDrop[],
): void {
  // Pre-bucketed per-vendor by the caller. Ladder pick replaces the rescale formula.
  let chosen: { ratio: number; kept: OfferModel[] } | null = null;
  for (const candidate of PAID_GROUP_RATIO_CANDIDATES) {
    const kept = offer.models.filter((m) => {
      const written = modelRatios.get(m.exposed);
      const ratio = written?.ratio ?? 1;
      const ceiling = canonical.get(m.exposed) ?? ratio;
      return ratio * candidate <= ceiling;
    });
    if (kept.length === offer.models.length) {
      chosen = { ratio: candidate, kept };
      break;
    }
    if (kept.length > 0 && !chosen) {
      chosen = { ratio: candidate, kept };
    }
  }

  if (!chosen || chosen.kept.length === 0) {
    for (const m of offer.models) {
      drops.push({
        model: m.exposed,
        channel: `${offer.sanitizedBase}-${offer.vendor}`,
        reason: "no-fit",
        detail: "no group_ratio candidate fits within canonical",
      });
    }
    return;
  }

  const keptSet = new Set(chosen.kept);
  for (const m of offer.models) {
    if (!keptSet.has(m)) {
      drops.push({
        model: m.exposed,
        channel: `${offer.sanitizedBase}-${offer.vendor}`,
        reason: "cap-exceeded",
        effectiveRatio: chosen.ratio,
        detail: `at chosen group_ratio=${chosen.ratio}`,
      });
    }
  }

  // One tier per paid offer (no sub-bucketing).
  const buckets = new Map<number, OfferModel[]>();
  buckets.set(chosen.ratio, chosen.kept);
  pushBucketsAsTiers(offer, buckets, tiers);
}

// =========================================================================
// No-upstream-ratio offers (sub2api): use cheapest existing
// group_ratio for the model across baseline + phase A tiers, then apply
// the per-model adjustment. Tiers are bucketed by computed ratio.
// =========================================================================

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
  for (const m of offer.models) {
    const adjustment = resolvePriceAdjustment({
      adj: offer.priceAdjustment,
      model: m.exposed,
      vendor: offer.vendor,
      modelType: m.modelType,
      fallback: offer.defaultAdjustment,
      modelMapping: args.modelMapping,
    });

    const cheapest = cheapestForModel.get(m.exposed) ?? offer.groupRatio;
    const groupRatio = cheapest * (1 + adjustment);

    // Cap: never sell above 1x canonical.
    if (groupRatio > 1) {
      const written = modelRatios.get(m.exposed)?.ratio ?? 1;
      const charge = written * groupRatio;
      const ceiling = canonical.get(m.exposed) ?? written;
      if (charge > ceiling) {
        drops.push({
          model: m.exposed,
          channel: `${offer.sanitizedBase}-${offer.vendor}`,
          reason: "cap-exceeded",
          effectiveRatio: groupRatio,
        });
        continue;
      }
    }

    const key = Math.round(groupRatio * 1e6) / 1e6;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(m);
  }

  if (buckets.size === 0) return;
  pushBucketsAsTiers(offer, buckets, tiers);
}

// ─── Bucket → tier (task-override sub-split + name suffixes) ────────────────

function pushBucketsAsTiers(
  offer: UpstreamOffer,
  buckets: Map<number, OfferModel[]>,
  tiers: PricedTier[],
): void {
  let tierIdx = 0;
  for (const [groupRatio, bucketModels] of buckets) {
    // Task-model override fires only when upstream exposes openai-video, or when endpoint data is absent.
    const subGroups = new Map<
      string,
      { models: OfferModel[]; channelType?: number; baseUrlSuffix?: string }
    >();
    for (const m of bucketModels) {
      const isTaskUpstream = m.endpoints
        ? m.endpoints.includes("openai-video")
        : true;
      const override = isTaskUpstream ? getTaskModelOverride(m.exposed) : undefined;
      const key = override
        ? `${override.channelType}:${override.baseUrlSuffix ?? ""}`
        : "default";
      let entry = subGroups.get(key);
      if (!entry) {
        entry = {
          models: [],
          channelType: override?.channelType,
          baseUrlSuffix: override?.baseUrlSuffix,
        };
        subGroups.set(key, entry);
      }
      entry.models.push(m);
    }

    let subIdx = 0;
    for (const [, sub] of subGroups) {
      const tierSuffix =
        buckets.size > 1 || subGroups.size > 1
          ? `-t${tierIdx}${subGroups.size > 1 ? String.fromCharCode(97 + subIdx) : ""}`
          : "";
      const channelName = `${offer.sanitizedBase}-${offer.vendor}${tierSuffix}`;
      const channelType = sub.channelType ?? offer.channelType;
      const baseUrl =
        offer.baseUrl.replace(/\/$/, "") + (sub.baseUrlSuffix ?? "");

      // Reverse mapping for this tier only (models where exposed !== upstream).
      const tierModelMapping: Record<string, string> = {};
      for (const m of sub.models) {
        if (m.exposed !== m.upstream) {
          tierModelMapping[m.exposed] = m.upstream;
        }
      }

      // emit() reads these to build capabilities JSON.
      const tierDetails: ModelTestDetail[] = [];
      for (const m of sub.models) {
        if (m.testDetail) tierDetails.push(m.testDetail);
      }

      tiers.push({
        channelName,
        vendor: offer.vendor,
        channelType,
        baseUrl,
        apiKey: offer.apiKey,
        providerTag: offer.provider,
        channelRemark: offer.channelRemark,
        groupRatio,
        groupDescription: `${sanitizeGroupName(offer.group)} via ${offer.provider} (${offer.vendor})`,
        models: sub.models.map((m) => m.exposed),
        modelMapping:
          Object.keys(tierModelMapping).length > 0
            ? tierModelMapping
            : undefined,
        testDetails: tierDetails.length > 0 ? tierDetails : undefined,
      });
      subIdx++;
    }
    tierIdx++;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildBaselineCheapestMap(baseline: BaselineInputs): Map<string, number> {
  const groupRatioByName = new Map<string, number>(
    baseline.groups.map((g) => [g.name, g.ratio]),
  );
  const cheapest = new Map<string, number>();
  for (const ch of baseline.channels) {
    const gRatio = groupRatioByName.get(ch.group) ?? 1;
    for (const m of parseModelList(ch.models)) {
      const cur = cheapest.get(m);
      if (cur === undefined || gRatio < cur) {
        cheapest.set(m, gRatio);
      }
    }
  }
  return cheapest;
}

