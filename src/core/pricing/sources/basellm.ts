import {
  forEachVendor,
  inferVendorFromModelName,
} from "@core/catalog/constants/vendor-matchers";
import { parseModelList } from "@core/catalog/constants/patterns";
import { type BasellmEntry, buildFuzzyIndex } from "@core/catalog/metadata";
import { t } from "@server/i18n";
import { consola } from "consola";
import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
} from "./types";

function buildVendorNameSet(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  forEachVendor((vendor, matcher) => {
    const set = new Set<string>();
    if (matcher.displayName) set.add(matcher.displayName.toLowerCase());
    set.add(vendor.toLowerCase());
    for (const alias of matcher.nameAliases ?? []) set.add(alias.toLowerCase());
    result.set(vendor, set);
  });
  return result;
}

function isCanonical(
  modelName: string,
  vendorName: string,
  canonicalSets: Map<string, Set<string>>,
): boolean {
  const inferred = inferVendorFromModelName(modelName);
  if (!inferred) return false;
  return canonicalSets.get(inferred)?.has(vendorName.toLowerCase()) ?? false;
}

function entryToPricing(entry: BasellmEntry): BaseModelPricing | undefined {
  if (entry.ratio_model == null || entry.ratio_model <= 0) return undefined;
  return {
    modelRatio: entry.ratio_model,
    completionRatio: entry.ratio_completion ?? 1,
    cacheRatio: entry.ratio_cache ?? undefined,
    source: "basellm",
    sourceKey: entry.vendor_name
      ? `${entry.vendor_name}/${entry.model_name}`
      : entry.model_name,
  };
}

function entryToMetadata(entry: BasellmEntry): SourceMetadata {
  const md: SourceMetadata = {};
  if (!entry.tags) return md;
  const tags = parseModelList(entry.tags);
  md.supportsTools = tags.some((t) => /^Tools$/i.test(t));
  md.supportsVision = tags.some((t) => /^Vision$/i.test(t));
  md.isReasoning = tags.some((t) => /^Reasoning$/i.test(t));
  for (const t of tags) {
    const m = t.match(/^(\d+(?:\.\d+)?)([KM])$/i);
    if (m) {
      const n = parseFloat(m[1]!);
      const tokens = m[2]!.toUpperCase() === "M" ? n * 1_000_000 : n * 1_000;
      md.contextWindow = Math.round(tokens);
      md.maxInputTokens = Math.round(tokens);
      break;
    }
  }
  return md;
}

export function buildBasellmCanonicalSource(
  entries: BasellmEntry[],
): PricingSource | null {
  if (entries.length === 0) {
    consola.warn(t("CORE.PRICING.BASELLM_NO_ENTRIES_SOURCE"));
    return null;
  }

  const canonicalSets = buildVendorNameSet();
  const pricingMap = new Map<string, BaseModelPricing>();
  const metadataMap = new Map<string, SourceMetadata>();
  const setMeta = (name: string, meta: SourceMetadata) => {
    if (Object.keys(meta).length > 0 && !metadataMap.has(name))
      metadataMap.set(name, meta);
  };

  for (const entry of entries) {
    if (!entry.model_name || !entry.vendor_name) continue;
    if (!isCanonical(entry.model_name, entry.vendor_name, canonicalSets)) {
      setMeta(entry.model_name, entryToMetadata(entry));
      continue;
    }
    const pricing = entryToPricing(entry);
    if (pricing) {
      const existing = pricingMap.get(entry.model_name);
      if (!existing || pricing.modelRatio < existing.modelRatio) {
        pricingMap.set(entry.model_name, pricing);
      }
    }
    setMeta(entry.model_name, entryToMetadata(entry));
  }

  consola.info(
    t("CORE.PRICING.BASELLM_LOADED", {
      loaded: pricingMap.size,
      total: entries.length,
    }),
  );

  return {
    name: "basellm",
    pricing: buildFuzzyIndex(pricingMap),
    metadata: buildFuzzyIndex(metadataMap),
  };
}
