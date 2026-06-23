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

const GENAI_PRICES_URL =
  "https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/data.json";

// A price field is either a flat USD/M number or a tiered object {base, tiers}.
// We only ever want the base (cheapest tier) for canonical resolution.
type PriceField = number | { base?: number } | undefined;
type PricesBlock = { input_mtok?: PriceField; output_mtok?: PriceField };
interface GenaiModel {
  id?: string;
  name?: string;
  // Flat object, or a list of tiered entries each nesting its own `prices`.
  prices?: PricesBlock | Array<{ prices?: PricesBlock }>;
}
interface GenaiProvider {
  id?: string;
  models?: GenaiModel[];
}
type GenaiResponse = GenaiProvider[];

const baseOf = (p: PriceField): number | undefined => {
  if (typeof p === "number") return p;
  if (p && typeof p === "object" && typeof p.base === "number") return p.base;
  return undefined;
};

const flatPrices = (prices: GenaiModel["prices"]): PricesBlock | undefined => {
  if (Array.isArray(prices)) return prices[0]?.prices;
  return prices;
};

const bare = (id: string): string => {
  const i = id.lastIndexOf("/");
  return (i >= 0 ? id.slice(i + 1) : id).toLowerCase();
};

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export async function fetchGenaiPricesSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<GenaiResponse>(GENAI_PRICES_URL, {
    timeoutMs: 15_000,
  });
  if (!raw || !Array.isArray(raw)) {
    consola.warn(t("CORE.PRICING.GENAI_PRICES_FETCH_FAILED"));
    return null;
  }

  const byModel = new Map<string, { input: number; output: number }[]>();
  for (const provider of raw) {
    for (const m of provider.models ?? []) {
      const block = flatPrices(m.prices);
      const input = baseOf(block?.input_mtok);
      if (input == null || input <= 0) continue;
      const output = baseOf(block?.output_mtok) ?? input;
      const key = bare(m.id ?? m.name ?? "");
      if (!key) continue;
      let arr = byModel.get(key);
      if (!arr) byModel.set(key, (arr = []));
      arr.push({ input, output });
    }
  }

  const pricingMap = new Map<string, BaseModelPricing>();
  for (const [model, quotes] of byModel) {
    const input = median(quotes.map((q) => q.input));
    const output = median(quotes.map((q) => q.output));
    pricingMap.set(model, {
      modelRatio: usdPerTokenToRatio(input / 1_000_000),
      completionRatio: output > 0 ? output / input : 1,
      source: "genai-prices",
      sourceKey: model,
    });
  }

  consola.info(
    t("CORE.PRICING.GENAI_PRICES_LOADED", { count: pricingMap.size }),
  );

  return {
    name: "genai-prices",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(new Map<string, SourceMetadata>()),
  };
}
