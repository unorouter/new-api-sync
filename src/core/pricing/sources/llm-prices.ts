import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildPricingMaps } from "./build";
import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
} from "./types";

const LLM_PRICES_URL = "https://www.llm-prices.com/current-v1.json";

interface LlmPricesEntry {
  id: string;
  vendor: string;
  name: string;
  /** USD/M tokens. */
  input: number;
  output: number;
  input_cached: number | null;
}

interface LlmPricesResponse {
  updated_at?: string;
  prices?: LlmPricesEntry[];
}

function toPricing(
  _key: string,
  entry: LlmPricesEntry,
): BaseModelPricing | undefined {
  if (entry.input == null || entry.input <= 0) return undefined;
  // USD/M ÷ 2 = new-api ratio.
  const modelRatio = entry.input / 2;
  const completionRatio =
    entry.output != null && entry.output > 0 ? entry.output / entry.input : 1;
  const pricing: BaseModelPricing = {
    modelRatio,
    completionRatio,
    source: "llm-prices",
    sourceKey: `${entry.vendor}/${entry.id}`,
  };
  if (entry.input_cached != null) {
    pricing.cacheRatio = entry.input_cached / entry.input;
  }
  return pricing;
}

function toMetadata(_entry: LlmPricesEntry): SourceMetadata {
  return {}; // pricing-only
}

/** Undiscounted list prices (promos elsewhere distort); highest-priority canonical source. */
export async function fetchLlmPricesSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<LlmPricesResponse>(LLM_PRICES_URL, {
    timeoutMs: 15_000,
  });
  if (!raw?.prices || !Array.isArray(raw.prices)) {
    consola.warn(t("CORE.PRICING.LLM_PRICES_FETCH_FAILED"));
    return null;
  }

  // bare ids; build.ts dual-keys by id and vendor/id.
  const validEntries: [string, LlmPricesEntry][] = [];
  for (const entry of raw.prices) {
    if (!entry.id) continue;
    validEntries.push([entry.id, entry]);
  }

  const { pricingMap, metadataMap } = buildPricingMaps({
    entries: validEntries,
    toPricing,
    toMetadata,
  });

  consola.info(
    t("CORE.PRICING.LLM_PRICES_LOADED", {
      count: pricingMap.size,
      updated: raw.updated_at ?? "unknown",
    }),
  );

  return {
    name: "llm-prices",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(metadataMap),
  };
}
