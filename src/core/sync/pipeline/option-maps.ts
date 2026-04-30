import type {
  GridPricingInfo,
  ManagedOptionMaps,
  MergedGroup,
  MergedModel,
} from "@core/types";

/**
 * Translate the priced plan's merged groups + models into the option maps
 * new-api stores in its global Options table (GroupRatio, ModelRatio,
 * CompletionRatio, ModelPrice, ImageRatio, CacheRatio, CreateCacheRatio,
 * ModelQuotaType, ModelGridPricing, AutoGroups, UserUsableGroups).
 *
 * Pure: no I/O, no state mutation. The diff phase rounds, merges with
 * unmanaged options, and writes them via target.updateOption.
 */
export function buildOptionMaps(
  mergedGroups: MergedGroup[],
  mergedModels: Map<string, MergedModel>,
  modelMapping: Record<string, string>,
  configGridPricing: Record<string, Record<string, string | number>[]>,
): Omit<ManagedOptionMaps, "responsesApiModels" | "defaultUseAutoGroup"> {
  const groupRatio: Record<string, number> = {};
  const userUsableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)",
  };

  for (const group of mergedGroups) {
    groupRatio[group.name] = Math.round(group.ratio * 10000) / 10000;
    userUsableGroups[group.name] = group.description;
  }

  const autoGroups = [...mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((group) => group.name);

  const modelRatio: Record<string, number> = {};
  const completionRatio: Record<string, number> = {};
  const modelPrice: Record<string, number> = {};
  const imageRatio: Record<string, number> = {};
  const cacheRatio: Record<string, number> = {};
  const createCacheRatio: Record<string, number> = {};
  const modelQuotaType: Record<string, number> = {};
  for (const [name, ratios] of mergedModels) {
    const mappedName = modelMapping?.[name] ?? name;
    const isPerRequest =
      ratios.quotaType !== undefined && ratios.quotaType >= 1;
    if (
      (ratios.modelPrice !== undefined && ratios.modelPrice > 0) ||
      isPerRequest
    ) {
      modelPrice[mappedName] =
        Math.round((ratios.modelPrice ?? 0) * 10000) / 10000;
    } else {
      modelRatio[mappedName] = Math.round(ratios.ratio * 10000) / 10000;
      completionRatio[mappedName] =
        Math.round(ratios.completionRatio * 10000) / 10000;
    }
    if (ratios.imageRatio !== undefined && ratios.imageRatio > 0) {
      imageRatio[mappedName] = Math.round(ratios.imageRatio * 10000) / 10000;
    }
    if (ratios.cacheRatio !== undefined && ratios.cacheRatio >= 0) {
      cacheRatio[mappedName] = Math.round(ratios.cacheRatio * 10000) / 10000;
    }
    if (ratios.createCacheRatio !== undefined && ratios.createCacheRatio >= 0) {
      createCacheRatio[mappedName] =
        Math.round(ratios.createCacheRatio * 10000) / 10000;
    }
    if (ratios.quotaType !== undefined && ratios.quotaType >= 1) {
      modelQuotaType[mappedName] = ratios.quotaType;
    }
  }

  // Build grid pricing display metadata from config.
  // Grid pricing is independent of quota_type: video models use quota_type=4,
  // image models keep quota_type=1 (per-request) but still show a resolution grid.
  const modelGridPricing: Record<string, GridPricingInfo> = {};
  for (const [modelName, rows] of Object.entries(configGridPricing)) {
    const mappedName = modelMapping?.[modelName] ?? modelName;
    if (
      modelPrice[mappedName] !== undefined ||
      modelRatio[mappedName] !== undefined
    ) {
      modelGridPricing[mappedName] = rows as GridPricingInfo;
    }
  }

  return {
    groupRatio,
    userUsableGroups,
    autoGroups,
    modelRatio,
    completionRatio,
    modelPrice,
    imageRatio,
    cacheRatio,
    createCacheRatio,
    modelQuotaType,
    modelGridPricing,
  };
}
