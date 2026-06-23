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

const AIPRICING_URL = "https://www.aipricing.guru/api/pricing.json";

interface AipricingModel {
  id?: string;
  name?: string;
  family?: string;
  provider?: string;
  pricing?: {
    inputPerM?: number;
    outputPerM?: number;
    cachedInputPerM?: number;
  };
}
interface AipricingResponse {
  models?: AipricingModel[];
}

// ids are provider-prefixed without a slash ("together-glm-5.1"); strip the
// leading provider token so distinct providers collapse onto one bare model.
const stripProvider = (id: string, provider?: string): string => {
  let s = id.toLowerCase();
  if (provider && s.startsWith(provider.toLowerCase() + "-")) {
    s = s.slice(provider.length + 1);
  }
  return s;
};

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface Quote {
  input: number;
  output: number;
  cached?: number;
}

export async function fetchAipricingSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<AipricingResponse>(AIPRICING_URL, {
    timeoutMs: 15_000,
  });
  if (!raw?.models || !Array.isArray(raw.models)) {
    consola.warn(t("CORE.PRICING.AIPRICING_FETCH_FAILED"));
    return null;
  }

  const byModel = new Map<string, Quote[]>();
  for (const m of raw.models) {
    const id = m.id;
    const input = m.pricing?.inputPerM;
    if (!id || typeof input !== "number" || input <= 0) continue;
    const output =
      typeof m.pricing?.outputPerM === "number" ? m.pricing.outputPerM : input;
    const key = stripProvider(id, m.provider);
    let arr = byModel.get(key);
    if (!arr) byModel.set(key, (arr = []));
    arr.push({
      input,
      output,
      cached:
        typeof m.pricing?.cachedInputPerM === "number"
          ? m.pricing.cachedInputPerM
          : undefined,
    });
  }

  const pricingMap = new Map<string, BaseModelPricing>();
  for (const [model, quotes] of byModel) {
    const input = median(quotes.map((q) => q.input));
    const output = median(quotes.map((q) => q.output));
    const pricing: BaseModelPricing = {
      modelRatio: usdPerTokenToRatio(input / 1_000_000),
      completionRatio: output > 0 ? output / input : 1,
      source: "aipricing",
      sourceKey: model,
    };
    const cached = quotes.find((q) => q.cached != null)?.cached;
    if (cached != null) pricing.cacheRatio = cached / input;
    pricingMap.set(model, pricing);
  }

  consola.info(t("CORE.PRICING.AIPRICING_LOADED", { count: pricingMap.size }));

  return {
    name: "aipricing",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(new Map<string, SourceMetadata>()),
  };
}
