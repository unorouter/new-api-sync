import { tryFetchJson } from "@core/infra/http";
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
  freeIds: string[];
}

const ENDPOINT_PROBE_CONCURRENCY = 8;

function isZeroPricing(p: OpenRouterPricing | undefined): boolean {
  if (!p) return false;
  for (const v of Object.values(p)) {
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n !== 0) return false;
  }
  return true;
}

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

  if (!raw?.data?.length) return { freeIds: [] };

  const candidates = raw.data.filter((m) => isZeroPricing(m.pricing));
  consola.info(
    t("CORE.OPENROUTER.PROBING_ENDPOINTS", { count: candidates.length }),
  );

  const limit = pLimit(ENDPOINT_PROBE_CONCURRENCY);
  const results = await Promise.all(
    candidates.map((m) =>
      limit(async () => {
        const endpoints = await fetchModelEndpoints(baseUrl, apiKey, m.id);
        const hasFree = endpoints.some(
          (ep) => (ep.status ?? 0) >= 0 && isZeroPricing(ep.pricing) && ep.tag,
        );
        return { id: m.id, hasFree };
      }),
    ),
  );

  const freeIds: string[] = [];
  for (const r of results) if (r.hasFree) freeIds.push(r.id);
  return { freeIds };
}
