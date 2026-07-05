import {
  CHANNEL_TYPES,
  getTaskModelOverride,
} from "@core/catalog/constants/channel-types";
import {
  parseModelList,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
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
  // A `:free` alias must never inherit a paid sticker. Zero modelPrice covers the
  // per-request path (group_ratio 0 alone would not make it free there), and zero
  // ratio/completionRatio covers per-token display: a mirrored paid ratio hides the
  // alias from the free model list even though group_ratio 0 already bills it at 0.
  if (aliasName.endsWith(":free")) {
    modelRatios.set(aliasName, {
      ...base,
      ratio: 0,
      completionRatio: 0,
      modelPrice: 0,
    });
    return;
  }
  modelRatios.set(aliasName, { ...base });
}

interface BillingFields {
  billingMode?: string;
  billingExpr?: string;
  audioRatio?: number;
  audioCompletionRatio?: number;
  pricingVersion?: string;
}

/**
 * Pick the billing fields written to the merged model.
 *
 * Tiered billing_expr is intentionally NOT adopted: a tiered upstream is
 * flattened to a single ratio derived from its HIGHEST tier (see
 * effectiveRatioFromBillingExpr, which feeds each tiered OfferModel's
 * upstreamRatio). Flat-at-highest-tier means we never undercharge relative to
 * the upstream's most expensive tier, and the published price is a clean
 * per-token ratio instead of leaking the upstream's region-list tier curve.
 *
 * audio_ratio / audio_completion_ratio / pricing_version are upstream-agnostic
 * metadata; first non-undefined wins.
 */
function pickBillingFields(
  occurrences: { model: OfferModel }[],
): BillingFields {
  return {
    billingMode: undefined,
    billingExpr: undefined,
    audioRatio: occurrences.find((o) => o.model.audioRatio !== undefined)?.model
      .audioRatio,
    audioCompletionRatio: occurrences.find(
      (o) => o.model.audioCompletionRatio !== undefined,
    )?.model.audioCompletionRatio,
    pricingVersion: occurrences.find((o) => o.model.pricingVersion)?.model
      .pricingVersion,
  };
}

const bucketKey = (r: number) => Math.round(r * 1e6) / 1e6;
const channelOf = (o: UpstreamOffer) => `${o.sanitizedBase}-${o.vendor}`;
export const isFixed = (w: { modelPrice?: number; quotaType?: number }) =>
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
    const billing = pickBillingFields(occurrences);
    const fm = occurrences.find((o) => isFixed(o.model))?.model;
    if (fm) {
      // Fixed-price billing (quotaType >= 1) bypasses the ratio path, so a
      // group_ratio of 0 does NOT make a free-tier model free; only a zero
      // modelPrice does. Force it when every occurrence is free, else a `:free`
      // per-image/per-call model would still bill its sticker price.
      const allFree = occurrences.every((o) => o.model.isFree);
      modelRatios.set(model, {
        ratio: existing?.ratio ?? 0,
        completionRatio: existing?.completionRatio ?? 0,
        modelPrice: allFree ? 0 : (fm.modelPrice ?? existing?.modelPrice),
        quotaType: fm.quotaType ?? existing?.quotaType,
        cacheRatio: existing?.cacheRatio ?? fm.cacheRatio,
        createCacheRatio: existing?.createCacheRatio ?? fm.createCacheRatio,
        imageRatio: existing?.imageRatio,
        audioRatio: existing?.audioRatio ?? billing.audioRatio,
        audioCompletionRatio:
          existing?.audioCompletionRatio ?? billing.audioCompletionRatio,
        billingMode: existing?.billingMode ?? billing.billingMode,
        billingExpr: existing?.billingExpr ?? billing.billingExpr,
        pricingVersion: billing.pricingVersion,
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

    // No fixed occurrence: this model bills per-token (ratio + completionRatio). If we resolved a
    // real ratio (source/canonical/upstream), it is genuinely per-token now, so DROP any stale
    // existing per-call sticker (e.g. a model that used to be flat-priced) instead of inheriting it.
    const haveRealRatio =
      sourceHit !== undefined ||
      canonicalRatio !== undefined ||
      co !== undefined;
    modelRatios.set(model, {
      ratio: writtenRatio,
      completionRatio,
      cacheRatio: cacheRatio ?? existing?.cacheRatio,
      createCacheRatio: createCacheRatio ?? existing?.createCacheRatio,
      modelPrice: haveRealRatio ? undefined : existing?.modelPrice,
      quotaType: haveRealRatio ? undefined : existing?.quotaType,
      imageRatio: existing?.imageRatio,
      audioRatio: existing?.audioRatio ?? billing.audioRatio,
      audioCompletionRatio:
        existing?.audioCompletionRatio ?? billing.audioCompletionRatio,
      billingMode: existing?.billingMode ?? billing.billingMode,
      billingExpr: existing?.billingExpr ?? billing.billingExpr,
      pricingVersion: billing.pricingVersion,
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
      offer.isFreeTier === true ||
      offer.models.every((m) => m.isFree);
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
      const adj = adjustmentFor(offer, m, args);
      const base = offer.groupRatio * (1 + adj);
      if (!isFixed(written)) {
        // Per-token: scale each channel's group ratio by its own upstream ratio
        // vs the stored sticker, so a pricier relay charges proportionally more.
        // The token ratio markup gives margin headroom, so a negative adjustment
        // still clears cost.
        groupRatio =
          m.upstreamRatio !== undefined && written.ratio > 0
            ? base * (m.upstreamRatio / written.ratio)
            : base;
      } else {
        // Per-request (fixed price): scale each channel's group ratio by its own
        // per-call price vs the stored sticker (cheapest relay wins the sticker),
        // so a pricier relay's retail tracks its own upstream price, then apply the
        // adjustment. Net: retail = upstreamPrice * (1 + adjustment), per channel.
        // adj -0.75 = sell 75% below the relay's upstream price.
        const mp = m.modelPrice ?? written.modelPrice;
        const sticker = written.modelPrice;
        groupRatio =
          mp !== undefined && sticker !== undefined && sticker > 0
            ? base * (mp / sticker)
            : base;
      }
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
    // Base group ratio = an existing positive cheapest ratio, else 1.0 (full retail:
    // the per-token price already lives in ModelRatio, so the group multiplier starts
    // at 1 for a freshly-priced model, e.g. a paid override in an otherwise-free
    // provider whose own groupRatio is 0). Then apply the adjustment.
    const cheap = cheapestForModel.get(m.exposed);
    const base = cheap && cheap > 0 ? cheap : offer.groupRatio || 1;
    const groupRatio = base * (1 + adj);
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

// One channel per model: each model maps to its own new-api channel so a per-model
// rate-limit (429) or a scheduled-test failure disables only that model, never its
// siblings. Channel name = {sanitizedBase}-{model} where sanitizedBase is the
// per-(provider,group) base, so the same model served by two upstream groups gets
// distinct channels. channelType/baseUrl come from the model's task override
// (falling back to the offer defaults). groupRatio is carried from the pricing bucket.
function pushBucketsAsTiers(
  offer: UpstreamOffer,
  buckets: Map<number, OfferModel[]>,
  tiers: PricedTier[],
  modelRatios: Map<string, MergedModel>,
): void {
  const baseUrlTrim = offer.baseUrl.replace(/\/$/, "");
  for (const [groupRatio, bucketModels] of buckets) {
    for (const m of bucketModels) {
      // Native video task types (Kling/Sora/Vidu/MiniMax/Doubao/Gemini/Ali) route the
      // gateway's per-second billing adaptors. Match by model NAME for any non-text model:
      // upstreams that proxy these (ephone, yun) label the endpoint with their own scheme
      // (e.g. "wan视频生成"), not "openai-video", so gating on the endpoint string missed
      // them and left the channel at OpenAI(1) -> wrong (Sora) adaptor.
      const override =
        m.modelType !== "text" ? getTaskModelOverride(m.exposed) : undefined;

      // Full free/paid split: a genuinely-free channel (groupRatio 0) publishes
      // the model as `{name}:free` so it has a distinct identity that can never
      // route to a paid channel; paid channels keep the base name. Routing is
      // unchanged (modelMapping -> m.upstream).
      const publishedName =
        groupRatio === 0 && !m.exposed.endsWith(":free")
          ? `${m.exposed}:free`
          : m.exposed;

      const modelMapping: Record<string, string> = {};
      if (publishedName !== m.upstream)
        modelMapping[publishedName] = m.upstream;
      if (publishedName !== m.exposed)
        mirrorAliasRatio(modelRatios, m.exposed, publishedName);

      const models = [publishedName];
      let hasContext1mAlias = false;
      if (isAnthropicNativeOffer(offer) && shouldAddContext1mAlias(m.exposed)) {
        const alias = `${publishedName}${CLAUDE_CONTEXT_1M_SUFFIX}`;
        models.push(alias);
        modelMapping[alias] = m.upstream;
        mirrorAliasRatio(modelRatios, publishedName, alias);
        hasContext1mAlias = true;
      }

      tiers.push({
        channelName: `${offer.sanitizedBase}-${sanitizeGroupName(publishedName)}`,
        vendor: offer.vendor,
        channelType: override?.channelType ?? offer.channelType,
        baseUrl: baseUrlTrim + (override?.baseUrlSuffix ?? ""),
        apiKey: offer.apiKey,
        providerTag: offer.provider,
        channelRemark: offer.channelRemark,
        groupRatio,
        groupDescription: `${publishedName} via ${offer.provider} (${offer.vendor})`,
        models,
        modelMapping: Object.keys(modelMapping).length
          ? modelMapping
          : undefined,
        testDetails: m.testDetail ? [m.testDetail] : undefined,
        paramOverride: hasContext1mAlias
          ? CLAUDE_CONTEXT_1M_PARAM_OVERRIDE
          : undefined,
        // Media channels carry refs/extras (image_urls, multipart) new-api drops on
        // re-marshal; pass the raw body through. EXCEPT ALI (17): DashScope's task
        // API needs the gateway's native-shape conversion (input.messages, model
        // rewrite), which pass-through would bypass -> 400/404.
        ...(m.modelType !== "text" &&
        (override?.channelType ?? offer.channelType) !== CHANNEL_TYPES.ALI
          ? { passThroughBody: true }
          : {}),
        ...(m.rateLimited ? { disabled: true } : {}),
      });
    }
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
