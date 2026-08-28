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
  fetchListings,
  groupByModel,
  selectMerchants,
  usdPerMillion,
  type Listing,
} from "./marketplace";
import {
  ensureLaneTokens,
  ensurePins,
  laneTokenName,
  type MerchantLane,
} from "./pins";

// new-api stores price as a ratio, not USD: ratio 1 is $2 per 1M tokens.
const USD_PER_M_PER_RATIO = 2;

function collectLanes(
  provider: A7ApiProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
  byModel: Map<string, Listing[]>,
): { lanes: MerchantLane[]; skippedModels: string[] } {
  const globs = getEnabledModelGlobs(provider.enabledModels) ?? [];
  const lanes: MerchantLane[] = [];
  const skippedModels: string[] = [];

  for (const [model, rows] of byModel) {
    if (matchesBlacklist(model, config.blacklist)) continue;
    if (globs.length > 0 && !matchesAnyPattern(model, globs)) continue;
    if (
      config.modelFilter?.length &&
      !matchesAnyPattern(model, config.modelFilter)
    )
      continue;

    // maxCost = canonicalList * sellAtPctOfList / minMargin, measured on the
    // output side. The vote's modelRatio is the input price in ratio units.
    const vote = resolveCanonicalByVote(
      model.toLowerCase(),
      ctx.pricingSources,
      ctx.reverseMapping,
    );
    const canonicalListUsd = vote.cluster
      ? vote.cluster.modelRatio *
        USD_PER_M_PER_RATIO *
        (vote.cluster.completionRatio ?? 1)
      : undefined;

    const chosen = selectMerchants(rows, provider, canonicalListUsd);
    if (chosen.length === 0) {
      skippedModels.push(model);
      continue;
    }
    const canonicalInputRatio = vote.cluster?.modelRatio;
    for (const listing of chosen)
      lanes.push({ model, listing, canonicalInputRatio });
  }
  return { lanes, skippedModels };
}

// applyPriceAdjustment interpolates retail = cost + (ceiling - cost) * adj, so
// a flat adj of sellPct lands at sellPct + cost/2 of list, above the promise.
// Solve for the adj that lands exactly on sellPct * list. Undefined when the
// lane cannot be sold at sellPct with any margin (cost at/over the target).
function adjustmentForExactPct(
  sellPct: number,
  costRatio: number,
  canonicalInputRatio: number | undefined,
): number | undefined {
  if (canonicalInputRatio === undefined || canonicalInputRatio <= 0)
    return sellPct;
  const costShare = costRatio / canonicalInputRatio;
  if (costShare >= sellPct) return undefined;
  return (sellPct - costShare) / (1 - costShare);
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
    const { lanes, skippedModels } = collectLanes(
      provider,
      config,
      ctx,
      byModel,
    );
    const modelCount = new Set(lanes.map((l) => l.model)).size;
    consola.info(
      `[${name}] ${lanes.length} merchant lane(s) across ${modelCount} model(s), ${skippedModels.length} model(s) without a qualifying merchant`,
    );
    if (lanes.length === 0) {
      report.error = "no model had a merchant meeting the price/health rules";
      return { report, offers, endpointMetadata: { endpointPaths: new Map() } };
    }

    const skipCleanup =
      (config.modelFilter?.length ?? 0) > 0 ||
      (config.modelTypeFilter?.length ?? 0) > 0;
    const tokens = await ensureLaneTokens(provider, lanes, {
      dryRun,
      skipCleanup,
    });
    const pins = await ensurePins(provider, lanes, tokens, dryRun);
    consola.info(
      `[${name}] pins: +${pins.created} ~${pins.repinned} =${pins.unchanged}`,
    );

    // Cheapest lane per model keeps the plain channel; the rest are failover
    // duplicates so capAbove1x does not delete them as pricier copies.
    const cheapestByModel = new Map<string, number>();
    for (const lane of lanes) {
      const cur = cheapestByModel.get(lane.model);
      if (cur === undefined || lane.listing.input_price_micros < cur)
        cheapestByModel.set(lane.model, lane.listing.input_price_micros);
    }

    // Bare base: the test runner and new-api channel types append /v1/... themselves.
    const baseUrl = provider.baseUrl.replace(/\/$/, "");

    for (const lane of lanes) {
      const token = tokens.get(laneTokenName(lane));
      if (!token) continue;

      // Per-merchant label: the verdict cache is keyed provider|model, so a
      // shared label would reuse one merchant's probe result (and authenticity
      // blacklist) for every merchant of the model.
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
      const rateLimited = filterResult.rateLimitedModels.includes(lane.model);

      const input = usdPerMillion(lane.listing.input_price_micros);
      const output = usdPerMillion(lane.listing.output_price_micros);
      const upstreamRatio = input / USD_PER_M_PER_RATIO;
      const laneAdj = adjustmentForExactPct(
        provider.sellAtPctOfList ?? 0.5,
        upstreamRatio,
        lane.canonicalInputRatio,
      );
      if (laneAdj === undefined) continue;
      const isCheapest =
        lane.listing.input_price_micros === cheapestByModel.get(lane.model);
      const model: OfferModel = {
        exposed: lane.model.toLowerCase(),
        upstream: lane.model,
        modelType: inferModelType(lane.model),
        upstreamRatio,
        upstreamCompletionRatio: input > 0 ? output / input : 1,
        ...(rateLimited ? { rateLimited: true } : {}),
        ...(isCheapest ? {} : { failoverDuplicate: true }),
      };

      const vendor = inferVendorFromModelName(lane.model) ?? "unknown";
      offers.push({
        provider: name,
        providerKind: "a7api",
        group: `${vendor}-${lane.listing.channel_id}`,
        sanitizedBase: sanitizeGroupName(`${name}-${lane.listing.channel_id}`),
        vendor,
        channelType: CHANNEL_TYPES.OPENAI,
        baseUrl,
        apiKey: token.key,
        groupRatio: 1,
        channelRemark: `${lane.model} via ${name} merchant ${lane.listing.supplier_name} (#${lane.listing.channel_id})`,
        models: [model],
        priceAdjustment: provider.priceAdjustment ?? laneAdj,
        defaultAdjustment: 0,
      });
    }

    report.groups = offers.length;
    report.models = modelCount;
    report.success = true;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }

  return { report, offers, endpointMetadata: { endpointPaths: new Map() } };
}
