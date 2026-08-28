import { tryFetchJson } from "@core/infra/http";
import type { A7ApiProviderConfig } from "@core/validations/config";

// a7api resells other people's channels, so one model has many merchant
// listings at wildly different prices (claude-opus-5 spans $0.04 to $5.00).
// /api/pricing publishes a single placeholder ratio for every model, so the
// listings are the only real price source.
export interface Listing {
  channel_id: number;
  listing_id: number;
  supplier_name: string;
  model_name: string;
  charge_type: string;
  listing_availability: number;
  supplier_channel_disabled: boolean;
  user_channel_disabled: boolean;
  authenticity_guaranteed: boolean;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros?: number;
  recent_success_rate: number;
  sample_count: number;
}

interface SearchResponse {
  success?: boolean;
  message?: string;
  data?: { items?: Listing[]; total?: number };
}

const MICROS_PER_USD = 1e6;
// Success rate is 0-10000, not a percentage: 10000 is 100%.
const DEFAULT_MIN_SUCCESS_RATE = 9500;
// Floor only applies to merchants that HAVE samples: an unproven listing gets
// its chance (a failure costs nothing and the failure-rate guard disables it),
// but a merchant with a real track record below the floor is proven bad, and
// re-selecting it every run would loop: recreate, fail, disable, delete.
const PROVEN_SAMPLE_COUNT = 20;
const DEFAULT_SELL_AT_PCT_OF_LIST = 0.5;
const DEFAULT_MIN_MARGIN = 2;
const DEFAULT_MAX_PRICE_BAND = 2;

export function marketplaceHeaders(
  provider: A7ApiProviderConfig,
): Record<string, string> {
  return {
    Authorization: `Bearer ${provider.systemAccessToken}`,
    "New-Api-User": String(provider.userId),
  };
}

// One call returns the whole snapshot: the endpoint ignores page/size and
// answers from an in-memory view, so paginating would only refetch the same rows.
export async function fetchListings(
  provider: A7ApiProviderConfig,
): Promise<Listing[]> {
  const url =
    `${provider.baseUrl.replace(/\/$/, "")}/api/marketplace/channels/search` +
    `?route_status=all&exclude_unavailable=true&sort=price_asc`;
  const body = await tryFetchJson<SearchResponse>(url, {
    headers: marketplaceHeaders(provider),
    timeoutMs: 60_000,
  });
  if (!body?.success) return [];
  return body.data?.items ?? [];
}

export function groupByModel(listings: Listing[]): Map<string, Listing[]> {
  const byModel = new Map<string, Listing[]>();
  for (const row of listings) {
    const list = byModel.get(row.model_name);
    if (list) list.push(row);
    else byModel.set(row.model_name, [row]);
  }
  return byModel;
}

// Every merchant worth a channel, cheapest first. Three price-driven cuts, no
// count cap:
//   1. health: available, per-token, and not proven-bad (see PROVEN_SAMPLE_COUNT);
//   2. margin: output cost <= canonicalList * sellAtPctOfList / minMargin, so a
//      merchant we cannot make minMargin on never becomes a channel;
//   3. band: within maxPriceBand of this model's own cheapest survivor, because
//      merchant prices cluster near the floor and the long tail would never be
//      routed to (unbanded, the live snapshot yields ~4,900 channels).
// canonicalListUsd is the voted list output price in USD/1M; undefined skips the
// margin cut, matching how the rest of the engine degrades without canonical.
export function selectMerchants(
  rows: Listing[],
  provider: A7ApiProviderConfig,
  canonicalListUsd: number | undefined,
): Listing[] {
  const minSuccess = provider.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE;
  const sellPct = provider.sellAtPctOfList ?? DEFAULT_SELL_AT_PCT_OF_LIST;
  const minMargin = provider.minMargin ?? DEFAULT_MIN_MARGIN;
  const band = provider.maxPriceBand ?? DEFAULT_MAX_PRICE_BAND;
  const maxCostUsd =
    canonicalListUsd !== undefined
      ? (canonicalListUsd * sellPct) / minMargin
      : undefined;

  const viable = rows
    .filter(
      (r) =>
        r.charge_type === "per_token" &&
        r.listing_availability === 1 &&
        !r.supplier_channel_disabled &&
        !r.user_channel_disabled &&
        r.input_price_micros > 0 &&
        !(
          r.sample_count >= PROVEN_SAMPLE_COUNT &&
          r.recent_success_rate < minSuccess
        ) &&
        (!provider.guaranteedOnly || r.authenticity_guaranteed) &&
        (maxCostUsd === undefined ||
          usdPerMillion(r.output_price_micros) <= maxCostUsd),
    )
    .sort((a, b) => a.input_price_micros - b.input_price_micros);
  if (viable.length === 0) return [];

  const floor = viable[0]!.input_price_micros;
  return viable.filter((r) => r.input_price_micros <= floor * band);
}

export function usdPerMillion(micros: number): number {
  return micros / MICROS_PER_USD;
}
