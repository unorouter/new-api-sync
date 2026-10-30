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
  /** Share taken off the listed prices for now: Baidu lists deepseek at 81% off. */
  discount?: number | string;
  /** Prompt-length or time-of-day tiers (prompts of 100k+ cost 5x on haiku-5.5). */
  overrides?: OpenRouterPriceTier[];
}

type PricedField = "prompt" | "completion" | "input_cache_read";
type OpenRouterPriceTier = Partial<Record<PricedField, string>>;

// The most an endpoint can bill per token: its dearest tier with any discount
// undone. Lanes are priced on this, because OpenRouter bills the tier a request
// lands in and the discount can lapse; pricing on the base sold haiku-5.5's long
// prompts at 40% of cost and baidu's deepseek at a quarter of it.
function highestPrice(
  pricing: OpenRouterPricing | undefined,
  field: PricedField,
): number {
  const base = Number(pricing?.[field]);
  if (!Number.isFinite(base)) return Number.NaN;
  let highest = base;
  for (const tier of pricing?.overrides ?? []) {
    const v = Number(tier[field]);
    if (Number.isFinite(v) && v > highest) highest = v;
  }
  const discount = Number(pricing?.discount ?? 0);
  return discount > 0 && discount < 1 ? highest / (1 - discount) : highest;
}

interface OpenRouterModel {
  id: string;
  pricing?: OpenRouterPricing;
  architecture?: { input_modalities?: string[] };
}
interface OpenRouterEndpoint {
  provider_name?: string;
  tag?: string;
  status?: number;
  pricing?: OpenRouterPricing;
  uptime_last_1d?: number | null;
  quantization?: string | null;
  supported_parameters?: string[];
}

interface OpenRouterModelList {
  data: OpenRouterModel[];
}
interface OpenRouterEndpointsResponse {
  data?: { endpoints?: OpenRouterEndpoint[] };
}

export interface OpenRouterPaidEndpoint {
  provider: string;
  tag: string;
  prompt: number;
  completion: number;
  cacheRead?: number;
  status: number;
  /** OpenRouter's 1-day uptime %, null when the host is too new to have stats. */
  uptime?: number | null;
  /** "fp8" / "fp4" / "unknown". Absent on hosts that do not report one. */
  quantization?: string;
  /** What THIS host accepts. Hosts of the same model differ (one takes no
   *  frequency_penalty/presence_penalty/stop where the maker's own endpoint does),
   *  and a pinned host 400s on a param it does not list. */
  supportedParameters?: string[];
}

export interface OpenRouterCatalogue {
  freeIds: string[];
  /** The providers serving each free id at a zero price, which its free lane pins. */
  freeProviders: Map<string, string[]>;
  /** Per-model upstream-host pricing for explicitly-requested paid ids. */
  paidEndpoints: Map<string, OpenRouterPaidEndpoint[]>;
  /** Model ids whose input modalities do NOT include "image". A request
   *  carrying one fails outright on these, so the channel strips it. */
  textOnlyIds: Set<string>;
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

function freeProvidersOf(endpoints: OpenRouterEndpoint[]): string[] {
  const names = endpoints
    .filter(
      (ep) => (ep.status ?? 0) >= 0 && isZeroPricing(ep.pricing) && ep.tag,
    )
    .map((ep) => ep.provider_name ?? "")
    .filter((n) => n !== "");
  return [...new Set(names)];
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
  paidIds: string[] = [],
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

  if (!raw?.data?.length)
    return {
      freeIds: [],
      freeProviders: new Map(),
      paidEndpoints: new Map(),
      textOnlyIds: new Set(),
    };

  // Modality is a property of the model, not of a host, so it is read once from
  // the catalogue rather than per endpoint.
  const textOnlyIds = new Set(
    raw.data
      .filter((m) => {
        const inputs = m.architecture?.input_modalities;
        return (
          Array.isArray(inputs) &&
          inputs.length > 0 &&
          !inputs.includes("image")
        );
      })
      .map((m) => m.id),
  );

  const candidates = raw.data.filter((m) => isZeroPricing(m.pricing));
  consola.info(
    t("CORE.OPENROUTER.PROBING_ENDPOINTS", { count: candidates.length }),
  );

  const limit = pLimit(ENDPOINT_PROBE_CONCURRENCY);
  const results = await Promise.all(
    candidates.map((m) =>
      limit(async () => {
        const endpoints = await fetchModelEndpoints(baseUrl, apiKey, m.id);
        return { id: m.id, providers: freeProvidersOf(endpoints) };
      }),
    ),
  );

  const freeProviders = new Map<string, string[]>();
  for (const r of results)
    if (r.providers.length > 0) freeProviders.set(r.id, r.providers);

  const paidEndpoints = new Map<string, OpenRouterPaidEndpoint[]>();
  await Promise.all(
    paidIds.map((id) =>
      limit(async () => {
        const endpoints = await fetchModelEndpoints(baseUrl, apiKey, id);
        // A paid model can carry one free provider; it gets a free lane of its own.
        const free = freeProvidersOf(endpoints);
        if (free.length > 0) freeProviders.set(id, free);
        const hosts: OpenRouterPaidEndpoint[] = [];
        for (const ep of endpoints) {
          const prompt = highestPrice(ep.pricing, "prompt");
          const completion = highestPrice(ep.pricing, "completion");
          if (!Number.isFinite(prompt) || prompt <= 0) continue;
          const cacheReadRaw = highestPrice(ep.pricing, "input_cache_read");
          hosts.push({
            provider: ep.provider_name ?? "",
            tag: ep.tag ?? "",
            prompt,
            completion: Number.isFinite(completion) ? completion : prompt,
            cacheRead: Number.isFinite(cacheReadRaw) ? cacheReadRaw : undefined,
            status: ep.status ?? 0,
            uptime: ep.uptime_last_1d ?? null,
            quantization: ep.quantization ?? undefined,
            supportedParameters: Array.isArray(ep.supported_parameters)
              ? ep.supported_parameters
              : undefined,
          });
        }
        if (hosts.length > 0) paidEndpoints.set(id, hosts);
      }),
    ),
  );

  return {
    freeIds: [...freeProviders.keys()],
    freeProviders,
    paidEndpoints,
    textOnlyIds,
  };
}
