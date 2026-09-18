import {
  matchesAnyPattern,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import { resolvePerModel } from "@core/pricing";
import { CLAUDE_CONTEXT_1M_OPERATIONS } from "@core/pricing/compute";
import type { OfferModel, UpstreamOffer } from "@core/pricing/offers";
import type { ModelTestDetail } from "@core/testing/types";
import { t } from "@server/i18n";
import { consola } from "consola";

// Lanes bought from a marketplace (relay pools, order-book sellers) sit behind
// the a7 lanes of the same model: a lane group's ratio orders the gateway's auto
// groups, so a dearer lane only serves once the cheaper ones fail.

const USD_PER_M_PER_RATIO = 2;
export const DEFAULT_FALLBACK_MULTIPLE = 2;
export const DEFAULT_BID_QUANTILE = 0.5;

/** The ask at which at least `q` of the providers behind a price ladder are
 *  eligible. A bid at the cheapest ask leaves one provider to serve the lane. */
export function ladderQuantile(
  points: readonly (readonly [number, number])[],
  q: number,
): number | undefined {
  const sorted = points
    .filter(([price, count]) => price > 0 && count > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((n, [, count]) => n + count, 0);
  if (total === 0) return undefined;
  let seen = 0;
  for (const [price, count] of sorted) {
    seen += count;
    if (seen >= total * q) return price;
  }
  return sorted[sorted.length - 1]?.[0];
}

export function resolvePools(
  value: string[] | Record<string, string[]>,
  model: string,
): string[] {
  if (Array.isArray(value)) return value.map((p) => p.toLowerCase());
  const hit = Object.entries(value).find(
    ([glob]) => glob !== "default" && matchesAnyPattern(model, [glob]),
  );
  return (hit?.[1] ?? value["default"] ?? []).map((p) => p.toLowerCase());
}

export interface FallbackLane {
  exposed: string;
  /** Model id the lane calls upstream with. */
  upstream: string;
  /** Upstream pool the lane is pinned to, part of the channel name; empty
   *  when the lane spans every allowed seller. */
  pool: string;
  /** $/M the lane is priced at: the most its spend guard lets a request cost. */
  inputUsd: number;
  outputUsd: number;
  listInputUsd?: number;
  listOutputUsd?: number;
  channelType: number;
  baseUrl: string;
  operations: Record<string, unknown>[];
  /** Fields every probe must carry to reach the same sellers as the lane. */
  probeBody?: Record<string, unknown>;
  remark: string;
  testDetail?: ModelTestDetail;
  rateLimited?: boolean;
}

/** The lane's retail multiple, lowered so retail never passes list. Undefined
 *  when even 1x would sell above list: the lane costs too much to carry. */
export function laneMultiple(
  provider: {
    name: string;
    profitMultiple?: number | Record<string, number>;
  },
  lane: FallbackLane,
): number | undefined {
  const wanted = resolvePerModel(
    provider.profitMultiple,
    lane.exposed,
    DEFAULT_FALLBACK_MULTIPLE,
  );
  const headroom = Math.min(
    lane.listInputUsd && lane.inputUsd > 0
      ? lane.listInputUsd / lane.inputUsd
      : Infinity,
    lane.listOutputUsd && lane.outputUsd > 0
      ? lane.listOutputUsd / lane.outputUsd
      : Infinity,
  );
  const multiple = Math.min(wanted, headroom);
  if (multiple < 1) {
    consola.warn(
      t("CORE.FALLBACK.OVER_LIST", {
        name: provider.name,
        model: lane.exposed,
        pool: lane.pool,
        cost: lane.outputUsd.toFixed(4),
        list: (lane.listOutputUsd ?? 0).toFixed(4),
      }),
    );
    return undefined;
  }
  return multiple;
}

export function buildFallbackOffer(opts: {
  provider: string;
  providerKind: string;
  apiKey: string;
  multiple: number;
  lane: FallbackLane;
}): UpstreamOffer {
  const lane = opts.lane;
  const vendor = inferVendorFromModelName(lane.exposed) ?? "other";
  // A model override suppresses the engine's own [1m] alias override, so a
  // Claude lane carries that operation itself; it only fires on the alias.
  const operations =
    vendor === "anthropic"
      ? [...lane.operations, ...CLAUDE_CONTEXT_1M_OPERATIONS]
      : lane.operations;
  const model: OfferModel = {
    exposed: lane.exposed,
    upstream: lane.upstream,
    modelType: "text",
    upstreamRatio: lane.inputUsd / USD_PER_M_PER_RATIO,
    upstreamCompletionRatio:
      lane.inputUsd > 0 ? lane.outputUsd / lane.inputUsd : 1,
    ...(operations.length > 0
      ? { paramOverride: JSON.stringify({ operations }) }
      : {}),
    ...(lane.testDetail ? { testDetail: lane.testDetail } : {}),
    ...(lane.rateLimited ? { rateLimited: true } : {}),
  };
  return {
    provider: opts.provider,
    providerKind: opts.providerKind,
    group: lane.pool ? `${vendor}-${lane.pool}` : vendor,
    sanitizedBase: sanitizeGroupName(
      lane.pool ? `${opts.provider}-${lane.pool}` : opts.provider,
    ),
    vendor,
    channelType: lane.channelType,
    baseUrl: lane.baseUrl,
    apiKey: opts.apiKey,
    groupRatio: opts.multiple,
    channelRemark: lane.remark,
    models: [model],
    priceAdjustment: { default: 0 },
    defaultAdjustment: 0,
  };
}

/** Bid prices go out as header values; six decimals keeps sub-cent asks. */
export function bidValue(usdPerMillion: number): string {
  return usdPerMillion.toFixed(6).replace(/\.?0+$/, "");
}
