import type { RuntimeConfig } from "@core/config";
import { resolvePerModel } from "@core/pricing/index";
import { clickhouseLines } from "@core/sync/reconcile/gateway-logs";
import type { Channel } from "@core/types";
import { DEFAULT_FALLBACK_MULTIPLE } from "@core/vendors/shared/fallback-lanes";

// Live lanes and the ones the gateway pulled itself (status 3), which its own
// test brings back; a manual pull (2) stays out.
const PRICED_STATUSES = new Set([1, 3]);
const WINDOW_HOURS = 6;
const MIN_REQUESTS = 20;
// A request the lane's price undercharges is billed at its own cost times this
// (channel upstream_cost_markup); the lane price never sits below it either.
export const REALIZED_COST_FLOOR = 1.1;
const QUOTA_PER_USD = 500000;

// A marketplace lane is priced on what its spend guard lets a request cost, but
// each request goes to whichever seller is cheapest then and sellers bill cached
// tokens at up to the full input price, so the guard is a guess. The gateway
// logs what the market actually billed (`admin_info.upstream_cost_usd`); over a
// window that is the lane's real cost per billed unit at group ratio 1.
const QUERY = `
SELECT
  channel_id AS channelId,
  toUInt32(count()) AS requests,
  sum(JSONExtractFloat(other, 'admin_info', 'upstream_cost_usd')) AS cost,
  sum((prompt_tokens - JSONExtractInt(other, 'cache_tokens')
       + JSONExtractInt(other, 'cache_tokens') * JSONExtractFloat(other, 'cache_ratio')
       + completion_tokens * JSONExtractFloat(other, 'completion_ratio'))
      * JSONExtractFloat(other, 'model_ratio')) / {quotaPerUsd:Float64} AS baseUsd
FROM logs
WHERE type = 2 AND channel_id IN {ids:Array(UInt32)}
  AND created_at >= {from:Int64}
  AND JSONExtractFloat(other, 'admin_info', 'upstream_cost_usd') > 0
  AND JSONExtractFloat(other, 'model_price') < 0
GROUP BY channel_id`;

export interface RealizedRatio {
  provider: string;
  ratio: number;
  realized: number;
  requests: number;
}

type MarketplaceProvider = {
  name: string;
  type: string;
  profitMultiple?: number | Record<string, number>;
};

function marketplaceProviders(config: RuntimeConfig): MarketplaceProvider[] {
  const out: MarketplaceProvider[] = [];
  for (const p of config.providers)
    if (p.type === "si" || p.type === "ih")
      out.push({
        name: p.name,
        type: p.type,
        profitMultiple: p.profitMultiple,
      });
  return out;
}

/**
 * Group ratio per live marketplace lane from what the market really billed:
 * real cost times the provider's profitMultiple, never under the cost floor and
 * capped at list (1) unless the real cost itself is above it. Lanes with too
 * few costed requests in the window are left out and keep their order book price.
 */
export async function realizedMarketplaceRatios(
  config: RuntimeConfig,
  channels: readonly Channel[],
): Promise<Map<string, RealizedRatio>> {
  const out = new Map<string, RealizedRatio>();
  const dbUrl = config.targetDb?.url;
  if (!dbUrl || !/^https?:/.test(dbUrl)) return out;
  const providers = new Map(
    marketplaceProviders(config).map((p) => [p.name, p]),
  );
  const lanes = channels.filter(
    (ch) =>
      PRICED_STATUSES.has(ch.status ?? 0) &&
      ch.id != null &&
      !!ch.group &&
      providers.has(ch.tag ?? ""),
  );
  if (lanes.length === 0) return out;
  const byId = new Map(lanes.map((ch) => [ch.id, ch]));
  const lines = await clickhouseLines(dbUrl, QUERY, {
    ids: `[${lanes.map((ch) => ch.id).join(",")}]`,
    from: String(Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600),
    quotaPerUsd: String(QUOTA_PER_USD),
  });
  for (const line of lines) {
    const row: unknown = JSON.parse(line);
    if (!row || typeof row !== "object") continue;
    const id = Number(Reflect.get(row, "channelId"));
    const requests = Number(Reflect.get(row, "requests"));
    const cost = Number(Reflect.get(row, "cost"));
    const baseUsd = Number(Reflect.get(row, "baseUsd"));
    const ch = byId.get(id);
    if (!ch || requests < MIN_REQUESTS || !(cost > 0) || !(baseUsd > 0))
      continue;
    const provider = providers.get(ch.tag ?? "");
    if (!provider) continue;
    const model = ch.models.split(",")[0]!.trim();
    const multiple = resolvePerModel(
      provider.profitMultiple,
      model,
      DEFAULT_FALLBACK_MULTIPLE,
    );
    const realized = cost / baseUsd;
    const floor = realized * REALIZED_COST_FLOOR;
    const ratio = Math.max(floor, Math.min(realized * multiple, 1));
    out.set(ch.group, {
      provider: provider.name,
      ratio: Math.round(ratio * 10000) / 10000,
      realized,
      requests,
    });
  }
  return out;
}
