import {
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/catalog/constants/patterns";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import { tryFetchJson } from "@core/infra/http";
import { resolvePerModel } from "@core/pricing";
import type { A7ProviderConfig } from "@core/validations/config";
import { consola } from "consola";
import pLimit from "p-limit";

// a7 resells other people's channels, so one model has many merchant
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
// a7's success rate comes from its own small-prompt probe and disagrees with
// ours (4134 read 97% at 66% errors on our lane): the live probe is the gate,
// the floor is an opt-in knob.
const DEFAULT_MIN_SUCCESS_RATE = 0;
// Floor only applies to merchants that HAVE samples: an unproven listing gets
// its chance (a failure costs nothing and the failure-rate guard disables it),
// but a merchant with a real track record below the floor is proven bad, and
// re-selecting it every run would loop: recreate, fail, disable, delete.
const PROVEN_SAMPLE_COUNT = 20;
export const DEFAULT_PROFIT_MULTIPLE = 2;
// Retail never exceeds canonical list, so a merchant whose cost * profitMultiple
// would sell above list is rejected; the per-model knob only tightens that.
export const DEFAULT_MAX_SELL_FRACTION = 1;

export function marketplaceHeaders(
  provider: A7ProviderConfig,
): Record<string, string> {
  return {
    Authorization: `Bearer ${provider.systemAccessToken}`,
    "New-Api-User": String(provider.userId),
  };
}

// The unfiltered snapshot (thousands of rows, 17 MB) answers 200 and then
// stalls mid-stream: on 2026-09-16 every attempt was cut between 1.3 and 4.6 MB
// and four full walks died on "no listings". `model=` is a real server-side
// filter (`p` and `size` are ignored), exact and case sensitive, and a single
// model completes in seconds. Even the largest one (claude-opus-5, 410 rows)
// still stalls now and then, so a stall is reported as unknown, never as empty.
const LISTING_TIMEOUT_MS = 120_000;
const LISTING_CONCURRENCY = 3;

interface PricingResponse {
  success?: boolean;
  data?: { model_name?: string }[];
}

// /api/pricing is the cheap index of exact marketplace spellings: the filter
// wants `DeepSeek-V4-Flash-0731`, config says `deepseek-v4-flash-0731`.
export async function fetchMarketplaceModelNames(
  provider: A7ProviderConfig,
): Promise<string[] | null> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/api/pricing`;
  const body = await tryFetchJson<PricingResponse>(url, {
    headers: marketplaceHeaders(provider),
    timeoutMs: 60_000,
    retry: 2,
    retryDelayMs: 5_000,
  });
  if (!body?.success || !Array.isArray(body.data)) return null;
  const names = new Set<string>();
  for (const row of body.data) if (row.model_name) names.add(row.model_name);
  return [...names];
}

// The marketplace names this run should walk: the same three cuts the
// candidate walk applies (blacklist, enabled globs, --models), on exact names.
export function resolveMarketplaceModels(
  provider: A7ProviderConfig,
  config: RuntimeConfig,
  names: string[],
): string[] {
  const globs = getEnabledModelGlobs(provider.enabledModels) ?? [];
  return names.filter((model) => {
    if (matchesBlacklist(model, config.blacklist)) return false;
    if (globs.length > 0 && !matchesAnyPattern(model, globs)) return false;
    if (
      config.modelFilter?.length &&
      !matchesAnyPattern(model, config.modelFilter)
    )
      return false;
    return true;
  });
}

// null is "the marketplace could not say", [] is "no merchant lists it".
export async function fetchListingsForModel(
  provider: A7ProviderConfig,
  model: string,
): Promise<Listing[] | null> {
  const url =
    `${provider.baseUrl.replace(/\/$/, "")}/api/marketplace/channels/search` +
    `?model=${encodeURIComponent(model)}&route_status=all&exclude_unavailable=true&sort=price_asc`;
  const body = await tryFetchJson<SearchResponse>(url, {
    headers: marketplaceHeaders(provider),
    timeoutMs: LISTING_TIMEOUT_MS,
    retry: 2,
    retryDelayMs: 5_000,
  });
  if (!body?.success) return null;
  return (body.data?.items ?? []).filter((row) => row.model_name === model);
}

export async function fetchListingsByModel(
  provider: A7ProviderConfig,
  models: string[],
): Promise<{ byModel: Map<string, Listing[]>; failed: string[] }> {
  const byModel = new Map<string, Listing[]>();
  const failed: string[] = [];
  const limit = pLimit(LISTING_CONCURRENCY);
  await Promise.all(
    models.map((model) =>
      limit(async () => {
        const rows = await fetchListingsForModel(provider, model);
        if (rows === null) failed.push(model);
        else byModel.set(model, rows);
      }),
    ),
  );
  consola.info(
    `[${provider.name}] listings: ${byModel.size} model(s) fetched, ${failed.length} unreachable` +
      (failed.length > 0 ? ` (${failed.join(", ")})` : ""),
  );
  return { byModel, failed };
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
  provider: A7ProviderConfig,
  canonicalListUsd: number | undefined,
  blacklist?: string[],
): Listing[] {
  const minSuccess = resolvePerModel(
    provider.minSuccessRate,
    model,
    DEFAULT_MIN_SUCCESS_RATE,
  );
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
