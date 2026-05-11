import type {
  GridPricingInfo,
  ManagedOptionMaps,
  MergedGroup,
  MergedModel,
} from "@core/types";
import { t } from "@server/i18n";

export function buildOptionMaps(
  mergedGroups: MergedGroup[],
  mergedModels: Map<string, MergedModel>,
  modelMapping: Record<string, string>,
  configGridPricing: Record<string, Record<string, string | number>[]>,
): Omit<ManagedOptionMaps, "responsesApiModels" | "defaultUseAutoGroup"> {
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const groupRatio: Record<string, number> = {};
  const userUsableGroups: Record<string, string> = {
    auto: t("CORE.GROUPS.AUTO_LABEL"),
  };

  for (const group of mergedGroups) {
    groupRatio[group.name] = r4(group.ratio);
    userUsableGroups[group.name] = group.description;
  }

  const autoGroups = [...mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((g) => g.name);

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
      modelPrice[mappedName] = r4(ratios.modelPrice ?? 0);
    } else {
      modelRatio[mappedName] = r4(ratios.ratio);
      completionRatio[mappedName] = r4(ratios.completionRatio);
    }
    if (ratios.imageRatio !== undefined && ratios.imageRatio > 0)
      imageRatio[mappedName] = r4(ratios.imageRatio);
    if (ratios.cacheRatio !== undefined && ratios.cacheRatio >= 0)
      cacheRatio[mappedName] = r4(ratios.cacheRatio);
    if (ratios.createCacheRatio !== undefined && ratios.createCacheRatio >= 0)
      createCacheRatio[mappedName] = r4(ratios.createCacheRatio);
    if (ratios.quotaType !== undefined && ratios.quotaType >= 1)
      modelQuotaType[mappedName] = ratios.quotaType;
  }

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
