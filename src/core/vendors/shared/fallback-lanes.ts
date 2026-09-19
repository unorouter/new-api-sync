import {
  matchesAnyPattern,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import { resolvePerModel } from "@core/pricing";
import { CLAUDE_CONTEXT_1M_OPERATIONS } from "@core/pricing/compute";
import type { OfferModel, UpstreamOffer } from "@core/pricing/offers";
import type { ModelTestDetail } from "@core/testing/types";
import type { AnyProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";

// Lanes bought from a marketplace (relay pools, order-book sellers) sit behind
// the a7 lanes of the same model: a lane group's ratio orders the gateway's auto
// groups, so a dearer lane only serves once the cheaper ones fail.

export const MARKETPLACE_KINDS: ReadonlySet<AnyProviderConfig["type"]> =
  new Set(["ih", "si"]);

const USD_PER_M_PER_RATIO = 2;
const DEFAULT_FALLBACK_MULTIPLE = 2;
export const DEFAULT_BID_QUANTILE = 0.5;
// One seller behind a lane is one outage (or one dishonest key) from failing it.
export const DEFAULT_MIN_SELLERS = 3;

type Ladder = readonly (readonly [number, number])[];

const ladderAsks = (points: Ladder) =>
  points
    .filter(([price, count]) => price > 0 && count > 0)
    .sort((a, b) => a[0] - b[0]);

export const ladderSize = (points: Ladder) =>
  ladderAsks(points).reduce((n, [, count]) => n + count, 0);

/** The ask at which at least `q` of the providers behind a price ladder, and
 *  at least `minCount` of them, are eligible. A bid at the cheapest ask leaves
 *  one provider to serve the lane. */
export function ladderQuantile(
  points: Ladder,
  q: number,
  minCount = 1,
): number | undefined {
  const sorted = ladderAsks(points);
  const total = sorted.reduce((n, [, count]) => n + count, 0);
  if (total === 0 || total < minCount) return undefined;
  const need = Math.max(total * q, minCount);
  let seen = 0;
  for (const [price, count] of sorted) {
    seen += count;
    if (seen >= need) return price;
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
  /** Retail over inputUsd/outputUsd, from laneMultiple. */
  multiple: number;
  channelType: number;
  baseUrl: string;
  operations: Record<string, unknown>[];
  /** Fields every probe must carry to reach the same sellers as the lane. */
  probeBody?: Record<string, unknown>;
  remark: string;
  testDetail?: ModelTestDetail;
  rateLimited?: boolean;
}

export type LanePrice = Pick<
  FallbackLane,
  | "exposed"
  | "pool"
  | "inputUsd"
  | "outputUsd"
  | "listInputUsd"
  | "listOutputUsd"
>;

/** The lane's retail multiple with a7's per model knobs: profitMultiple, raised
 *  to the minSellFraction floor (read on output list, as a7 does) and cut to the
 *  maxSellFraction ceiling on both sides. Unlike an a7 merchant, a lane over the
 *  ceiling is repriced, not dropped; undefined when even 1x breaches it. */
export function laneMultiple(
  provider: {
    name: string;
    profitMultiple?: number | Record<string, number>;
    minSellFraction?: number | Record<string, number>;
    maxSellFraction?: number | Record<string, number>;
  },
  price: LanePrice,
): number | undefined {
  const model = price.exposed;
  const wanted = resolvePerModel(
    provider.profitMultiple,
    model,
    DEFAULT_FALLBACK_MULTIPLE,
  );
  const minSell = resolvePerModel(provider.minSellFraction, model, 0);
  const maxSell = resolvePerModel(provider.maxSellFraction, model, 1);
  const ceiling = Math.min(
    price.listInputUsd && price.inputUsd > 0
      ? (price.listInputUsd * maxSell) / price.inputUsd
      : Infinity,
    price.listOutputUsd && price.outputUsd > 0
      ? (price.listOutputUsd * maxSell) / price.outputUsd
      : Infinity,
  );
  const floor =
    price.listOutputUsd && price.outputUsd > 0
      ? (price.listOutputUsd * minSell) / price.outputUsd
      : 0;
  const multiple = Math.min(Math.max(wanted, floor), ceiling);
  const pool = price.pool || provider.name;
  if (multiple < 1) {
    consola.warn(
      t("CORE.FALLBACK.OVER_LIST", {
        name: provider.name,
        model,
        pool,
        cost: price.outputUsd.toFixed(4),
        ceiling: ((price.listOutputUsd ?? 0) * maxSell).toFixed(4),
        fraction: maxSell,
      }),
    );
    return undefined;
  }
  if (multiple !== wanted)
    consola.info(
      t("CORE.FALLBACK.REPRICED", {
        name: provider.name,
        model,
        pool,
        wanted,
        multiple: multiple.toFixed(2),
        floor: floor.toFixed(2),
        ceiling: ceiling.toFixed(2),
      }),
    );
  return multiple;
}

export function buildFallbackOffer(opts: {
  provider: string;
  providerKind: string;
  apiKey: string;
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
    groupRatio: lane.multiple,
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
