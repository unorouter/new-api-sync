import {
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/catalog/constants/patterns";
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
  channel_name: string;
  description: string;
  smart_routing_labels: string[];
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
  official_price?: { output_price_micros?: number };
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
export const DEFAULT_PROFIT_MULTIPLE = 2;
// Retail may not exceed this fraction of canonical list, so a merchant whose
// cost * profitMultiple would sell above it is rejected. kimi-k3: list $15,
// 0.5 => sell <= $7.50 => merchant output cost <= $3.75.
export const DEFAULT_MAX_SELL_FRACTION = 0.5;

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

// Every merchant worth a channel, cheapest first. Retail = merchant cost *
// profitMultiple (per lane, dynamic), so the only price cut is the sell ceiling:
// retail may not exceed maxSellFraction of canonical list, so a merchant whose
// cost * profitMultiple would sell above it is rejected. Cuts:
//   1. health: available, per-token, and not proven-bad (see PROVEN_SAMPLE_COUNT);
//   2. ceiling: cost * profitMultiple <= canonicalList * maxSellFraction (kimi-k3
//      list $15, 0.5 => sell <= $7.50 => merchant output cost <= $3.75);
//   3. count: the CALLER takes hostsPerModel merchants from the front; the full
//      viable list is returned so a merchant that fails its live probe can be
//      replaced by the next-cheapest candidate instead of shrinking the lane set.
// canonicalListUsd is the voted list output price in USD/1M; undefined skips the
// ceiling cut, matching how the rest of the engine degrades without canonical.
export function selectMerchants(
  model: string,
  rows: Listing[],
  provider: A7ApiProviderConfig,
  canonicalListUsd: number | undefined,
  blacklist?: string[],
): Listing[] {
  const minSuccess = provider.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE;
  const profitMultiple = resolvePerModel(
    provider.profitMultiple,
    model,
    DEFAULT_PROFIT_MULTIPLE,
  );
  const maxSellFraction = resolvePerModel(
    provider.maxSellFraction,
    model,
    DEFAULT_MAX_SELL_FRACTION,
  );
  const sellCeilingUsd =
    canonicalListUsd !== undefined
      ? canonicalListUsd * maxSellFraction
      : undefined;

  // Provider-scoped blacklist entries (a7/*kiro*) also fence merchant METADATA,
  // so a seller type can be banned without banning the model it sells. Only
  // scoped entries apply here: global entries are model-name fences and free
  // text would false-positive against them.
  const scoped = (blacklist ?? []).filter((e) =>
    e.toLowerCase().startsWith(`${provider.name.toLowerCase()}/`),
  );
  const excluded = (r: Listing) =>
    scoped.length > 0 &&
    [r.channel_name, r.description, r.supplier_name].some((f) =>
      matchesBlacklist(f, scoped, provider.name),
    );

  const viable = rows
    .filter(
      (r) =>
        !excluded(r) &&
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
        (sellCeilingUsd === undefined ||
          usdPerMillion(r.output_price_micros) * profitMultiple <=
            sellCeilingUsd),
    )
    .sort((a, b) => a.input_price_micros - b.input_price_micros);
  return viable;
}

export function usdPerMillion(micros: number): number {
  return micros / MICROS_PER_USD;
}

// Glob-keyed per-model override with a flat-number fallback, same lookup shape
// as hostsPerModel: first matching glob wins, then "default", then fallback.
export function resolvePerModel(
  value: number | Record<string, number> | undefined,
  model: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  const hit = Object.entries(value).find(([glob]) =>
    matchesAnyPattern(model, [glob]),
  );
  return hit?.[1] ?? value["default"] ?? fallback;
}

// Supplier names are mostly Chinese marketing strings and never unique
// (usetoken alone has 6 kimi-k3 listings), so the slug is a readable prefix
// and the channel_id stays the identifier. Empty slug = bare id.
export function supplierSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16)
    .replace(/-+$/, "");
}
