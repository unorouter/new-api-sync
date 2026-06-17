import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
  usdPerTokenToRatio,
} from "./types";

const MODELS_DEV_URL = "https://models.dev/api.json";

// First-party vendor catalogs win over reseller/region-list quotes when a
// model appears in them: a vendor's own entry is the authoritative list price.
// "zhipuai" is Zhipu's CNY open-platform list (inflated vs international); it is
// deliberately NOT preferred so glm-* clusters on the international USD price.
const FIRST_PARTY_PRIORITY = [
  "zai",
  "openai",
  "anthropic",
  "google",
  "mistral",
  "deepseek",
  "xai",
  "moonshotai",
  "alibaba",
] as const;

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}
interface ModelsDevModel {
  id?: string;
  cost?: ModelsDevCost;
}
interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}
type ModelsDevResponse = Record<string, ModelsDevProvider>;

const bare = (id: string): string => {
  const i = id.lastIndexOf("/");
  return (i >= 0 ? id.slice(i + 1) : id).toLowerCase();
};

interface Quote {
  input: number;
  output: number;
  cacheRead?: number;
  provider: string;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * One quote per bare model id. The vendor's own catalog (FIRST_PARTY_PRIORITY)
 * wins outright when present; otherwise the median across every provider quote
 * collapses reseller spread + region-list outliers (e.g. zhipuai $6) to a
 * single consensus price.
 */
function pickQuote(quotes: Quote[]): Quote | undefined {
  if (quotes.length === 0) return undefined;
  for (const p of FIRST_PARTY_PRIORITY) {
    const hit = quotes.find((q) => q.provider === p);
    if (hit) return hit;
  }
  const inMed = median(quotes.map((q) => q.input));
  const closest = quotes.reduce((a, b) =>
    Math.abs(b.input - inMed) < Math.abs(a.input - inMed) ? b : a,
  );
  return { ...closest, input: inMed };
}

export async function fetchModelsDevSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<ModelsDevResponse>(MODELS_DEV_URL, {
    timeoutMs: 15_000,
  });
  if (!raw || typeof raw !== "object") {
    consola.warn(t("CORE.PRICING.MODELS_DEV_FETCH_FAILED"));
    return null;
  }

  const byModel = new Map<string, Quote[]>();
  for (const [providerKey, provider] of Object.entries(raw)) {
    for (const [mid, model] of Object.entries(provider.models ?? {})) {
      const c = model.cost;
      const input = c?.input;
      if (typeof input !== "number" || input <= 0) continue;
      const output = typeof c?.output === "number" ? c.output : input;
      const key = bare(model.id ?? mid);
      let arr = byModel.get(key);
      if (!arr) byModel.set(key, (arr = []));
      arr.push({
        input,
        output,
        cacheRead: typeof c?.cache_read === "number" ? c.cache_read : undefined,
        provider: providerKey,
      });
    }
  }

  const pricingMap = new Map<string, BaseModelPricing>();
  for (const [model, quotes] of byModel) {
    const q = pickQuote(quotes);
    if (!q) continue;
    const pricing: BaseModelPricing = {
      modelRatio: usdPerTokenToRatio(q.input / 1_000_000),
      completionRatio: q.output > 0 ? q.output / q.input : 1,
      source: "models-dev",
      sourceKey: model,
    };
    if (q.cacheRead != null) pricing.cacheRatio = q.cacheRead / q.input;
    pricingMap.set(model, pricing);
  }

  consola.info(
    t("CORE.PRICING.MODELS_DEV_LOADED", { count: pricingMap.size }),
  );

  return {
    name: "models-dev",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(new Map<string, SourceMetadata>()),
  };
}
