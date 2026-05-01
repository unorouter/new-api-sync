import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/runtime";
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
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cached input tokens, or null. */
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
  // simonw stores USD per *million* tokens directly. new-api ratio = USD/M ÷ 2.
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
  // simonw/llm-prices is pricing-only; no capability flags or context windows.
  return {};
}

/**
 * Fetch + parse simonw/llm-prices catalog.
 *
 * This source is the only one that consistently carries *undiscounted* list
 * prices for promo'd models like DeepSeek V4 Pro. Used as the highest-priority
 * source in the canonical-by-vote resolver so the pre-test cap gate compares
 * upstream ratios against real list price, not promo'd OpenRouter values.
 */
export async function fetchLlmPricesSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<LlmPricesResponse>(LLM_PRICES_URL, {
    timeoutMs: 15_000,
  });
  if (!raw?.prices || !Array.isArray(raw.prices)) {
    consola.warn(t("CORE.PRICING.LLM_PRICES_FETCH_FAILED"));
    return null;
  }

  // simonw uses bare ids ("deepseek-v4-pro", "claude-sonnet-4.5") with vendor
  // as a separate field. Index by both bare id and vendor/id (matches the
  // dual-key convention in build.ts).
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
