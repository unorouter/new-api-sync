import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import {
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { resolveCanonicalByVote } from "@core/pricing/vote";
import { testAndFilterModels } from "@core/testing/runner";
import type { ProviderReport } from "@core/types";
import type { A7ApiProviderConfig } from "@core/validations/config";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import { consola } from "consola";
import {
  DEFAULT_PROFIT_MULTIPLE,
  fetchListings,
  groupByModel,
  resolvePerModel,
  selectMerchants,
  supplierSlug,
  usdPerMillion,
  type Listing,
} from "./marketplace";
import {
  cleanupStaleLaneTokens,
  ensureLaneTokens,
  ensurePins,
  laneTokenName,
  type MerchantLane,
} from "./pins";

// new-api stores price as a ratio, not USD: ratio 1 is $2 per 1M tokens.
const USD_PER_M_PER_RATIO = 2;

interface ModelCandidates {
  model: string;
  candidates: Listing[];
  wanted: number;
}

function collectCandidates(
  provider: A7ApiProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
  byModel: Map<string, Listing[]>,
): { models: ModelCandidates[]; skippedModels: string[] } {
  const globs = getEnabledModelGlobs(provider.enabledModels) ?? [];
  const models: ModelCandidates[] = [];
  const skippedModels: string[] = [];

  for (const [model, rows] of byModel) {
    if (matchesBlacklist(model, config.blacklist)) continue;
    if (globs.length > 0 && !matchesAnyPattern(model, globs)) continue;
    if (
      config.modelFilter?.length &&
      !matchesAnyPattern(model, config.modelFilter)
    )
      continue;

    // Cap cut: reject a merchant whose cost * profitMultiple breaches 1x list.
    // The vote's modelRatio is the input price in ratio units; USD list output.
    // Vote on the mapped (canonical) name: the marketplace spelling
    // (claude-opus-4-6) may miss the sources that know claude-opus-4.6.
    const exposedName = (config.modelMapping?.[model] ?? model).toLowerCase();
    const vote = resolveCanonicalByVote(
      exposedName,
      ctx.pricingSources,
      ctx.reverseMapping,
    );
    const canonicalListUsd = vote.cluster
      ? vote.cluster.modelRatio *
        USD_PER_M_PER_RATIO *
        (vote.cluster.completionRatio ?? 1)
      : undefined;

    const wanted =
      Object.entries(provider.hostsPerModel ?? {}).find(([glob]) =>
        matchesAnyPattern(model, [glob]),
      )?.[1] ?? 1;
    const candidates = selectMerchants(
      model,
      rows,
      provider,
      canonicalListUsd,
      config.blacklist,
    );
    if (candidates.length === 0) {
      skippedModels.push(model);
      continue;
    }
    models.push({ model, candidates, wanted });
  }
  return { models, skippedModels };
}

export async function processA7ApiProvider(
  provider: A7ApiProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): Promise<ProviderResult> {
  const name = provider.name;
  const report: ProviderReport = {
    name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  const dryRun = ctx.dryRun ?? false;

  try {
    const listings = await fetchListings(provider);
    if (listings.length === 0) {
      report.error = "marketplace returned no listings";
      return { report, offers, endpointMetadata: { endpointPaths: new Map() } };
    }

    const byModel = groupByModel(listings);
    const { models, skippedModels } = collectCandidates(
      provider,
      config,
      ctx,
      byModel,
    );
    const candidateTotal = models.reduce((n, m) => n + m.candidates.length, 0);
    consola.info(
      `[${name}] ${models.length} model(s), ${candidateTotal} candidate merchant(s), ${skippedModels.length} model(s) without a qualifying merchant`,
    );
    if (models.length === 0) {
      report.error = "no model had a merchant meeting the price/health rules";
      return { report, offers, endpointMetadata: { endpointPaths: new Map() } };
    }

    const skipCleanup =
      (config.modelFilter?.length ?? 0) > 0 ||
      (config.modelTypeFilter?.length ?? 0) > 0;

    // Bare base: the test runner and new-api channel types append /v1/... themselves.
    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    const keptLanes: MerchantLane[] = [];
    let pinsCreated = 0;
    let pinsRepinned = 0;

    for (const mc of models) {
      // Walk the cheap-sorted candidates until `wanted` merchants pass their
      // probe: a faker/dead pick is REPLACED by the next candidate instead of
      // shrinking the lane set (opus-5 hit zero lanes that way: the cheapest 6
      // were all blacklisted fakers, and nothing behind them was ever tried).
      // Cached verdicts skip without an upstream request, so the probe budget
      // only burns on genuinely new merchants.
      const budget = mc.wanted * 3;
      const kept: { lane: MerchantLane; key: string; rateLimited: boolean }[] =
        [];
      let idx = 0;
      let probed = 0;
      while (
        kept.length < mc.wanted &&
        idx < mc.candidates.length &&
        probed < budget
      ) {
        const take = Math.min(
          mc.wanted - kept.length,
          mc.candidates.length - idx,
          budget - probed,
        );
        const batch: MerchantLane[] = mc.candidates
          .slice(idx, idx + take)
          .map((listing) => ({ model: mc.model, listing }));
        idx += take;
        const tokens = await ensureLaneTokens(provider, batch, { dryRun });
        const pins = await ensurePins(provider, batch, tokens, dryRun);
        pinsCreated += pins.created;
        pinsRepinned += pins.repinned;

        for (const lane of batch) {
          const token = tokens.get(laneTokenName(lane));
          if (!token) continue;
          probed++;
          // Per-merchant label: the verdict cache is keyed provider|model, so a
          // shared label would reuse one merchant's probe result (and
          // authenticity blacklist) for every merchant of the model.
          const label = `${name}:${lane.listing.channel_id}`;
          const filterResult = await testAndFilterModels({
            allModels: [lane.model],
            baseUrl,
            apiKey: token.key,
            channelType: CHANNEL_TYPES.OPENAI,
            providerLabel: label,
            testableModelTypes: new Set(["text"]),
            acceptRateLimited: provider.acceptRateLimited,
          });
          if (filterResult.workingModels.length === 0) continue;
          kept.push({
            lane,
            key: token.key,
            rateLimited: filterResult.rateLimitedModels.includes(lane.model),
          });
        }
      }
      if (kept.length === 0) continue;
      keptLanes.push(...kept.map((k) => k.lane));

      // Cheapest KEPT lane per model gets the plain channel; the rest are
      // failover duplicates so capAbove1x does not delete them as pricier copies.
      const cheapestMicros = Math.min(
        ...kept.map((k) => k.lane.listing.input_price_micros),
      );
      for (const k of kept)
        offers.push(
          buildLaneOffer(
            provider,
            config,
            baseUrl,
            k.lane,
            k.key,
            k.rateLimited,
            k.lane.listing.input_price_micros === cheapestMicros,
          ),
        );
    }

    consola.info(`[${name}] pins: +${pinsCreated} ~${pinsRepinned}`);
    if (!dryRun && !skipCleanup)
      await cleanupStaleLaneTokens(provider, keptLanes);

    report.groups = offers.length;
    report.models = new Set(keptLanes.map((l) => l.model)).size;
    report.success = true;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }

  return { report, offers, endpointMetadata: { endpointPaths: new Map() } };
}

function buildLaneOffer(
  provider: A7ApiProviderConfig,
  config: RuntimeConfig,
  baseUrl: string,
  lane: MerchantLane,
  apiKey: string,
  rateLimited: boolean,
  isCheapest: boolean,
): UpstreamOffer {
  const name = provider.name;
  const input = usdPerMillion(lane.listing.input_price_micros);
  const output = usdPerMillion(lane.listing.output_price_micros);
  const upstreamRatio = input / USD_PER_M_PER_RATIO;
  const model: OfferModel = {
    exposed: (config.modelMapping?.[lane.model] ?? lane.model).toLowerCase(),
    upstream: lane.model,
    modelType: inferModelType(lane.model),
    upstreamRatio,
    upstreamCompletionRatio: input > 0 ? output / input : 1,
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(isCheapest ? {} : { failoverDuplicate: true }),
  };

  // Same shape as openrouter's per-host lanes: bake profitMultiple into
  // groupRatio and resolve adj to 0, so retail = upstreamRatio *
  // profitMultiple per lane WITHOUT the markup-override path. A per-model
  // positive adj would make this lane own the shared model sticker
  // (ModelRatio), which for a multi-source model (open1/pol also serve
  // kimi-k3) collapses everyone's sticker to a7's cheapest merchant cost.
  const profitMultiple = resolvePerModel(
    provider.profitMultiple,
    lane.model,
    DEFAULT_PROFIT_MULTIPLE,
  );

  const slug = supplierSlug(lane.listing.supplier_name);
  const laneId = slug
    ? `${slug}-${lane.listing.channel_id}`
    : `${lane.listing.channel_id}`;
  const vendor = inferVendorFromModelName(lane.model) ?? "unknown";
  return {
    provider: name,
    providerKind: "a7api",
    group: `${vendor}-${laneId}`,
    sanitizedBase: sanitizeGroupName(`${name}-${laneId}`),
    vendor,
    channelType: CHANNEL_TYPES.OPENAI,
    baseUrl,
    apiKey,
    groupRatio: profitMultiple,
    channelRemark: [
      `${lane.model} via ${name} merchant ${lane.listing.supplier_name} (#${lane.listing.channel_id})`,
      lane.listing.channel_name,
      lane.listing.description,
      lane.listing.smart_routing_labels?.join("/"),
    ]
      .filter(Boolean)
      .join(" | "),
    models: [model],
    priceAdjustment: { default: 0 },
    defaultAdjustment: 0,
  };
}
