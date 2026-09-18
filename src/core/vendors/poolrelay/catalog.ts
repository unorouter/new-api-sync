import { fetchJsonResult } from "@core/infra/http";

export interface PoolModel {
  id: string;
  /** Model id inside its pool; a request names it as `<prefix>/<upstreamModelId>`. */
  upstreamModelId: string;
  /** Official list $/M as a decimal string. */
  officialIn: string | null;
  officialOut: string | null;
  /** [ask $/M, providers asking it], one row per distinct ask. */
  pricePointsIn: [number, number][];
  pricePointsOut: [number, number][];
  enabled: boolean;
  modelDisabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export interface PoolUpstream {
  prefix: string;
  slug: string;
  status: string;
  upstreamDisabled: boolean;
  enabled: boolean;
  activeProviders: number;
  models: PoolModel[];
}

export type CatalogResult =
  | { ok: true; upstreams: PoolUpstream[] }
  | { ok: false; reason: string };

export async function fetchPoolCatalog(
  url: string,
  apiKey: string,
): Promise<CatalogResult> {
  const r = await fetchJsonResult<PoolUpstream[]>(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 30_000,
    retry: 2,
    retryDelayMs: 3_000,
  });
  if (!r.ok) return { ok: false, reason: r.message };
  if (!Array.isArray(r.data)) return { ok: false, reason: "not a list" };
  return { ok: true, upstreams: r.data };
}

export function officialUsd(value: string | null): number | undefined {
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
