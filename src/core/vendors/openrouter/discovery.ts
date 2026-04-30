import { tryFetchJson } from "@core/runtime";
import { t } from "@server/i18n";
import { consola } from "consola";
import pLimit from "p-limit";

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  image_output?: string;
  image_token?: string;
  audio?: string;
  audio_output?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  input_audio_cache?: string;
  internal_reasoning?: string;
  web_search?: string;
  discount?: string;
}

interface OpenRouterModel {
  id: string;
  canonical_slug?: string;
  pricing?: OpenRouterPricing;
}

interface OpenRouterEndpoint {
  provider_name?: string;
  tag?: string;
  status?: number;
  pricing?: OpenRouterPricing;
}

interface OpenRouterModelList {
  data: OpenRouterModel[];
}

interface OpenRouterEndpointsResponse {
  data?: { endpoints?: OpenRouterEndpoint[] };
}

export interface OpenRouterCatalogue {
  /** Model IDs with at least one healthy zero-cost endpoint. */
  freeIds: string[];
  /** Model IDs with no free endpoint (only paid routes available). */
  paidIds: string[];
  /** id -> true if free, false if paid. */
  isFreeById: Map<string, boolean>;
  /** id -> provider tags of the healthy zero-cost endpoints. */
  freeProviderTagsById: Map<string, string[]>;
}

const ENDPOINT_PROBE_CONCURRENCY = 8;

/** Every numeric pricing field parses to exactly 0. */
function isZeroPricing(p: OpenRouterPricing | undefined): boolean {
  if (!p) return false;
  for (const v of Object.values(p)) {
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n !== 0) return false;
  }
  return true;
}

/**
 * `/v1/models` shows only the cheapest route's headline price, so a model
 * with `pricing.prompt = "0"` may still bill on its actual provider routes.
 * For each candidate we hit `/v1/models/{slug}/endpoints` and accept it as
 * truly free only when at least one healthy endpoint has a fully-zero
 * pricing object. The endpoint tags are kept so the offer can later pin
 * routing via `provider.only` and avoid silent failover to a paid route.
 */
async function fetchModelEndpoints(
  baseUrl: string,
  apiKey: string,
  slug: string,
): Promise<OpenRouterEndpoint[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models/${slug}/endpoints`;
  const data = await tryFetchJson<OpenRouterEndpointsResponse>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });
  return data?.data?.endpoints ?? [];
}

export async function discoverOpenRouterFreeModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenRouterCatalogue> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: t("CORE.PROVIDER.LABEL_OPENROUTER"),
      url,
    }),
  );

  const raw = await tryFetchJson<OpenRouterModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const empty: OpenRouterCatalogue = {
    freeIds: [],
    paidIds: [],
    isFreeById: new Map(),
    freeProviderTagsById: new Map(),
  };
  if (!raw?.data?.length) return empty;

  // Stage 1: candidates worth probing - anything that claims to be free at
  // the catalogue level. A non-candidate (paid headline price) cannot have
  // a free underlying route, so we skip the per-model fetch.
  const candidates = raw.data.filter((m) => isZeroPricing(m.pricing));

  consola.info(
    t("CORE.OPENROUTER.PROBING_ENDPOINTS", { count: candidates.length }),
  );

  // Stage 2: per-endpoint verification. Concurrency-capped because
  // OpenRouter has no rate limits but we still want to be polite.
  const limit = pLimit(ENDPOINT_PROBE_CONCURRENCY);
  const results = await Promise.all(
    candidates.map((m) =>
      limit(async () => {
        const slug = m.canonical_slug ?? m.id;
        const endpoints = await fetchModelEndpoints(baseUrl, apiKey, slug);
        const freeTags: string[] = [];
        for (const ep of endpoints) {
          const healthy = (ep.status ?? 0) >= 0;
          if (healthy && isZeroPricing(ep.pricing) && ep.tag) {
            freeTags.push(ep.tag);
          }
        }
        return { id: m.id, freeTags };
      }),
    ),
  );

  const freeIds: string[] = [];
  const paidIds: string[] = [];
  const isFreeById = new Map<string, boolean>();
  const freeProviderTagsById = new Map<string, string[]>();
  for (const { id, freeTags } of results) {
    if (freeTags.length > 0) {
      freeIds.push(id);
      isFreeById.set(id, true);
      freeProviderTagsById.set(id, freeTags);
    } else {
      paidIds.push(id);
      isFreeById.set(id, false);
    }
  }
  // Models we never probed (paid headline) are recorded as paid so the
  // provider can still classify enabledModels extras without a second fetch.
  for (const m of raw.data) {
    if (!isFreeById.has(m.id)) isFreeById.set(m.id, false);
  }

  return { freeIds, paidIds, isFreeById, freeProviderTagsById };
}
