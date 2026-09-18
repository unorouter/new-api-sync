import { fetchJsonResult } from "@core/infra/http";

/** Prices are micro-USD per 1M tokens. */
export interface BookOffer {
  provider: string | null;
  seller_base_url: string | null;
  price_input_per_1m: number;
  price_output_per_1m: number;
  direct_input_per_1m: number | null;
  direct_output_per_1m: number | null;
  available: boolean;
  healthy: boolean;
  trusted: boolean;
  trades_24h: number;
}

interface MarketBook {
  model: string;
  offers: BookOffer[];
}

export interface SellerProviderInfo {
  id: string;
  name: string;
  host: string;
  trusted: boolean;
}

export type MarketResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

export async function fetchSellerProviders(
  baseUrl: string,
): Promise<MarketResult<SellerProviderInfo[]>> {
  const r = await fetchJsonResult<{ data?: SellerProviderInfo[] }>(
    `${baseUrl}/v1/providers`,
    { timeoutMs: 20_000, retry: 2, retryDelayMs: 3_000 },
  );
  if (!r.ok) return { ok: false, reason: r.message };
  if (!Array.isArray(r.data.data)) return { ok: false, reason: "not a list" };
  return { ok: true, data: r.data.data };
}

/** The public order book for one model; sellers only, no account needed. */
export async function fetchOrderBook(
  baseUrl: string,
  model: string,
): Promise<MarketResult<BookOffer[]>> {
  const r = await fetchJsonResult<MarketBook>(
    `${baseUrl}/api/markets/${encodeURIComponent(model)}`,
    { timeoutMs: 45_000, retry: 2, retryDelayMs: 3_000 },
  );
  if (!r.ok) return { ok: false, reason: r.message };
  if (!Array.isArray(r.data.offers)) return { ok: false, reason: "no offers" };
  return { ok: true, data: r.data.offers };
}

/** Model ids with a live market, to skip enabled globs nobody sells. */
export async function fetchMarketModels(
  baseUrl: string,
): Promise<MarketResult<string[]>> {
  const r = await fetchJsonResult<{ markets?: { model?: string }[] }>(
    `${baseUrl}/api/markets`,
    { timeoutMs: 60_000, retry: 2, retryDelayMs: 3_000 },
  );
  if (!r.ok) return { ok: false, reason: r.message };
  const models = (r.data.markets ?? [])
    .map((m) => m.model)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  return { ok: true, data: models };
}
