import {
  CHANNEL_TYPES,
  getTaskModelOverride,
} from "@core/catalog/constants/channel-types";
import {
  matchesAnyPattern,
  parseModelList,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import type { MergedModel } from "@core/types";
import {
  applyMarkupOverride,
  applyPriceAdjustment,
  resolvePriceAdjustment,
  resolvePriceAdjustmentDetailed,
  type ResolvedAdjustment,
} from "./index";
import type { OfferModel, UpstreamOffer } from "./offers";
import { resolveBasePricing } from "./resolver";
import type { PricingSource } from "./sources/types";
import type {
  BaselineInputs,
  PricedDrop,
  PricedPlan,
  PricedTier,
} from "./types";
import { resolvePerModel } from ".";

interface ComputeArgs {
  offers: UpstreamOffer[];
  baseline: BaselineInputs;
  canonical: Map<string, number>;
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
  modelMapping: Record<string, string>;
  modelAlias?: Record<string, string[]>;
  systemPrompt?: { models: string[]; prompt: string; override?: boolean }[];
  /** Per-provider scheduled-test cadence, keyed by provider name. */
  autoTestIntervalByProvider?: Map<string, number>;
  forceUpstreamStreamByProvider?: Map<
    string,
    boolean | Record<string, boolean>
  >;
  headerOverrideByProvider?: Map<string, string>;
  autoTestIntervalMaxByProvider?: Map<string, number>;
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

// Opt-in (per-model, via enabledModels metadata.disableThinking) override for
// reasoning models that spend the whole output budget on reasoning_content and
// return empty content (finish_reason=length). Sends ONLY the vLLM/sglang form
// (chat_template_kwargs.enable_thinking): logfare validates strictly and 400s
// (wrong_api_format) if the request carries unknown top-level thinking/
// enable_thinking props, so a "set all flags" override breaks it. This is the
// form logfare (and other vLLM-backed relays) actually honors.
export const DISABLE_THINKING_PARAM_OVERRIDE = JSON.stringify({
  operations: [
    { path: "chat_template_kwargs.enable_thinking", mode: "set", value: false },
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
  sourced: Set<string>,
): void {
  // Only an alias with its own upstream offer keeps its entry; a snapshot-seeded
  // one must follow the base or a stale sticker survives every run.
  if (sourced.has(aliasName)) return;
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
  imageRatio?: number;
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
    imageRatio: occurrences.find((o) => o.model.imageRatio !== undefined)?.model
      .imageRatio,
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
): number => resolveAdjustmentDetailed(offer, m, args).value;

const resolveAdjustmentDetailed = (
  offer: UpstreamOffer,
  m: OfferModel,
  args: ComputeArgs,
): ResolvedAdjustment =>
  resolvePriceAdjustmentDetailed({
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
  const sourced = new Set(offersByModel.keys());

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
        imageRatio: existing?.imageRatio ?? billing.imageRatio,
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
    let coOffer: UpstreamOffer | undefined;
    for (const occ of occurrences) {
      const om = occ.model;
      if (om.isFree || om.upstreamRatio === undefined) continue;
      if (co === undefined || om.upstreamRatio < co.upstreamRatio!) {
        co = om;
        coOffer = occ.offer;
      }
    }

    // Explicit per-model positive adj = a cost+markup lane: its sticker MUST be
    // the real upstream cost, not a pricing-source hit, or the source's completion
    // ratio skews the out-price away from cost * (1 + adj).
    const markupLane =
      co !== undefined &&
      coOffer !== undefined &&
      (() => {
        const r = resolveAdjustmentDetailed(coOffer, co, args);
        return r.perModel && r.value > 0;
      })();

    let writtenRatio: number;
    let completionRatio: number;
    let cacheRatio: number | undefined;
    let createCacheRatio: number | undefined;
    if (markupLane) {
      writtenRatio = co!.upstreamRatio!;
      completionRatio = co!.upstreamCompletionRatio ?? 1;
      cacheRatio = co!.cacheRatio;
      createCacheRatio = co!.createCacheRatio;
    } else if (sourceHit) {
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
      imageRatio: existing?.imageRatio ?? billing.imageRatio,
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
      processPaidOffer(offer, modelRatios, canonical, tiers, drops, sourced);
    else processStandardOffer(offer, modelRatios, args, tiers, sourced);

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
      sourced,
    );
  capAbove1x(tiers, modelRatios, canonical, drops);
  return { tiers, modelRatios, drops };
}

// Per model, on the priced tiers: DEDUPE. Keep the single cheapest channel, drop every
// pricier duplicate above 1x list. Pricing itself is already final and cap-safe: every
// path runs applyPriceAdjustment (positive adj interpolates cost -> canonical, so only
// the deliberate +5%-over-cost no-discount lane and negative-adj lanes can sit above 1x).
function capAbove1x(
  tiers: PricedTier[],
  modelRatios: Map<string, MergedModel>,
  canonical: Map<string, number>,
  drops: PricedDrop[],
): void {
  const unitOf = (model: string): number | undefined => {
    const w = modelRatios.get(model);
    if (!w) return undefined;
    return isFixed(w) ? w.modelPrice : w.ratio;
  };
  // Per model: every (tier, retail).
  const perModel = new Map<string, { tier: PricedTier; retail: number }[]>();
  for (const tier of tiers)
    for (const model of tier.models) {
      const unit = unitOf(model);
      if (unit === undefined) continue;
      (perModel.get(model) ?? perModel.set(model, []).get(model)!).push({
        tier,
        retail: unit * tier.groupRatio,
      });
    }
  const removeModelFromTier = (tier: PricedTier, model: string) => {
    tier.models = tier.models.filter((m) => m !== model);
    if (tier.modelMapping) delete tier.modelMapping[model];
    drops.push({
      model,
      channel: tier.channelName,
      reason: "cap-exceeded",
      effectiveRatio: tier.groupRatio,
    });
  };
  for (const [model, entries] of perModel) {
    const unit = unitOf(model);
    if (unit === undefined || unit <= 0) continue;
    // 1x ceiling = multi-source canonical, else the model's own sticker (the natural 1x).
    const ceiling = canonical.get(model) ?? unit;
    // Keep the cheapest, drop every pricier duplicate (cross-provider dedupe).
    // Failover channels (intentional same-model redundancy, e.g. an OpenRouter
    // pricier upstream host) are exempt: they survive at their own group ratio.
    const cheapest = entries.reduce((a, b) => (b.retail < a.retail ? b : a));
    for (const e of entries)
      if (
        e !== cheapest &&
        e.retail > ceiling + 1e-9 &&
        !e.tier.failoverDuplicate
      )
        removeModelFromTier(e.tier, model);
  }
  for (let i = tiers.length - 1; i >= 0; i--)
    if (tiers[i]!.models.length === 0) tiers.splice(i, 1);
}

function processStandardOffer(
  offer: UpstreamOffer,
  modelRatios: Map<string, MergedModel>,
  args: ComputeArgs,
  tiers: PricedTier[],
  sourced: Set<string>,
): void {
  const buckets = new Map<number, OfferModel[]>();
  for (const m of offer.models) {
    const written = modelRatios.get(m.exposed);
    if (!written) continue;
    let groupRatio: number;
    if (m.isFree) groupRatio = 0;
    else {
      const resolved = resolveAdjustmentDetailed(offer, m, args);
      const adj = resolved.value;
      if (!isFixed(written)) {
        // Per-token: cost tracks this channel's own upstream ratio vs the stored
        // sticker, so a pricier relay charges proportionally more.
        const cost =
          m.upstreamRatio !== undefined && written.ratio > 0
            ? offer.groupRatio * (m.upstreamRatio / written.ratio)
            : offer.groupRatio;
        const ceiling =
          written.ratio > 0
            ? (args.canonical.get(m.exposed) ?? written.ratio) / written.ratio
            : 0;
        // Explicit per-model positive adj = deliberate cost + markup, cap-EXEMPT.
        // Markup is off the model's OWN upstream cost (upstreamRatio) vs its sticker,
        // so retail = upstreamRatio * (1 + adj) even when offer.groupRatio is the
        // provider's free-tier 0 (a paid model in an otherwise-free provider).
        const markupBase =
          m.upstreamRatio !== undefined && written.ratio > 0
            ? m.upstreamRatio / written.ratio
            : cost;
        groupRatio =
          applyMarkupOverride(markupBase, resolved) ??
          applyPriceAdjustment(cost, adj, ceiling);
      } else {
        // Per-request (fixed price): cost tracks this channel's own per-call price
        // vs the stored sticker (cheapest relay wins the sticker), so a pricier
        // relay's retail follows its own upstream price, never the cheap sticker.
        const mp = m.modelPrice ?? written.modelPrice;
        const sticker = written.modelPrice;
        const cost =
          mp !== undefined && sticker !== undefined && sticker > 0
            ? offer.groupRatio * (mp / sticker)
            : offer.groupRatio;
        const ceiling =
          sticker !== undefined && sticker > 0
            ? (args.canonical.get(m.exposed) ?? sticker) / sticker
            : 0;
        groupRatio =
          applyMarkupOverride(cost, resolved) ??
          applyPriceAdjustment(cost, adj, ceiling);
      }
    }
    addToBucket(buckets, bucketKey(groupRatio), m);
  }
  if (buckets.size > 0)
    pushBucketsAsTiers(offer, buckets, tiers, modelRatios, sourced, args);
}

function processPaidOffer(
  offer: UpstreamOffer,
  modelRatios: Map<string, MergedModel>,
  canonical: Map<string, number>,
  tiers: PricedTier[],
  drops: PricedDrop[],
  sourced: Set<string>,
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
    sourced,
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
  sourced: Set<string>,
): void {
  const buckets = new Map<number, OfferModel[]>();
  const channel = channelOf(offer);
  for (const m of offer.models) {
    const resolved = resolveAdjustmentDetailed(offer, m, args);
    const adj = resolved.value;
    const written = modelRatios.get(m.exposed)?.ratio ?? 1;
    const ceiling = canonical.get(m.exposed) ?? written;
    // Cost basis (group-ratio space). A paid lane that carries its real upstream
    // cost (DeepInfra) prices off that cost vs the stored sticker; otherwise fall
    // back to an existing cheapest lane, else 1.0 (full sticker: the per-token
    // price already lives in ModelRatio).
    const cheap = cheapestForModel.get(m.exposed);
    const base =
      m.upstreamRatio !== undefined && written > 0
        ? m.upstreamRatio / written
        : cheap && cheap > 0
          ? cheap
          : offer.groupRatio || 1;
    // Explicit per-model positive adj = deliberate cost + markup, cap-EXEMPT: the
    // operator is pricing this model at cost*(1+adj) regardless of canonical (its
    // only market comparison sits below the target markup).
    const override = applyMarkupOverride(base, resolved);
    if (override !== undefined) {
      addToBucket(buckets, bucketKey(override), m);
      continue;
    }
    const groupRatio = applyPriceAdjustment(
      base,
      adj,
      written > 0 ? ceiling / written : 0,
    );
    if (groupRatio > 1 && written * groupRatio > ceiling + 1e-9) {
      drops.push({
        model: m.exposed,
        channel,
        reason: "cap-exceeded",
        effectiveRatio: groupRatio,
      });
      continue;
    }
    addToBucket(buckets, bucketKey(groupRatio), m);
  }
  if (buckets.size > 0)
    pushBucketsAsTiers(offer, buckets, tiers, modelRatios, sourced, args);
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
  sourced: Set<string>,
  args?: ComputeArgs,
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
        mirrorAliasRatio(modelRatios, m.exposed, publishedName, sourced);

      const models = [publishedName];
      let hasContext1mAlias = false;
      if (isAnthropicNativeOffer(offer) && shouldAddContext1mAlias(m.exposed)) {
        const alias = `${publishedName}${CLAUDE_CONTEXT_1M_SUFFIX}`;
        models.push(alias);
        modelMapping[alias] = m.upstream;
        mirrorAliasRatio(modelRatios, publishedName, alias, sourced);
        hasContext1mAlias = true;
      }

      // Config-driven pure aliases: publish extra names on THIS channel, all routing
      // to the same upstream + sharing pricing (one model, N names). For rebrands with
      // no independent upstream source (e.g. deepseek-v3.2-exp == deepseek-v3.2).
      for (const alias of args?.modelAlias?.[publishedName] ?? []) {
        if (models.includes(alias)) continue;
        models.push(alias);
        modelMapping[alias] = m.upstream;
        mirrorAliasRatio(modelRatios, publishedName, alias, sourced);
      }

      const sysPromptRule = args?.systemPrompt?.find((r) =>
        matchesAnyPattern(publishedName, r.models),
      );

      let paramOverride = m.paramOverride;
      if (!paramOverride && hasContext1mAlias)
        paramOverride = CLAUDE_CONTEXT_1M_PARAM_OVERRIDE;
      else if (!paramOverride && m.metadata?.disableThinking)
        paramOverride = DISABLE_THINKING_PARAM_OVERRIDE;

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
        paramOverride,
        ...(args?.autoTestIntervalByProvider?.get(offer.provider)
          ? {
              autoTestIntervalMinutes: args.autoTestIntervalByProvider.get(
                offer.provider,
              ),
            }
          : {}),
        ...(args?.autoTestIntervalMaxByProvider?.get(offer.provider)
          ? {
              autoTestIntervalMaxMinutes:
                args.autoTestIntervalMaxByProvider.get(offer.provider),
            }
          : {}),
        ...(args?.headerOverrideByProvider?.get(offer.provider)
          ? {
              headerOverride: args.headerOverrideByProvider.get(offer.provider),
            }
          : {}),
        ...(m.failoverDuplicate ? { failoverDuplicate: true } : {}),
        // Media channels carry refs/extras (image_urls, multipart) new-api drops on
        // re-marshal; pass the raw body through. EXCEPT ALI (17): DashScope's task
        // API needs the gateway's native-shape conversion (input.messages, model
        // rewrite), which pass-through would bypass -> 400/404. And EXCEPT
        // chat-completions image models on GEMINI (24) channels (gemini-*-image, no task
        // override): they are sent an OpenAI `messages` body, so pass-through skips the
        // gateway's messages -> contents conversion and the native API answers
        // "contents is required". Task-routed Gemini models (veo/imagen) still need it.
        ...(m.modelType !== "text" &&
        (override?.channelType ?? offer.channelType) !== CHANNEL_TYPES.ALI &&
        !(
          (override?.channelType ?? offer.channelType) ===
            CHANNEL_TYPES.GEMINI && !override
        )
          ? { passThroughBody: true }
          : {}),
        ...(resolvePerModel(
          args?.forceUpstreamStreamByProvider?.get(offer.provider),
          publishedName,
          false,
        )
          ? { forceUpstreamStream: true }
          : {}),
        ...(m.rateLimited || offer.upstreamDown ? { disabled: true } : {}),
        ...(sysPromptRule
          ? {
              systemPrompt: sysPromptRule.prompt,
              systemPromptOverride: sysPromptRule.override ?? false,
            }
          : {}),
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
