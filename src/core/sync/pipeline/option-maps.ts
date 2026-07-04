import type { RuntimeConfig } from "@core/config";
import type {
  GridPricingInfo,
  ManagedOptionMaps,
  MergedGroup,
  MergedModel,
} from "@core/types";
import { t } from "@server/i18n";
import micromatch from "micromatch";

// Per-model rate limits apply ONLY to `:free` published names; paid models are
// never limited. Expands config globs to the exact `:free` names present.
export function expandRateLimitModels(
  names: Iterable<string>,
  rateLimit: RuntimeConfig["rateLimit"],
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  const limitGlobs = Object.entries(rateLimit?.models ?? {});
  if (limitGlobs.length === 0) return out;
  for (const name of names) {
    if (!name.endsWith(":free")) continue;
    for (const [glob, limits] of limitGlobs) {
      if (micromatch.isMatch(name, glob)) {
        // Gateway option format is [totalAttempts, successCount].
        out[name] = [limits.total ?? 0, limits.success];
        break;
      }
    }
  }
  return out;
}

export function buildOptionMaps(
  mergedGroups: MergedGroup[],
  mergedModels: Map<string, MergedModel>,
  modelMapping: Record<string, string>,
  configGridPricing: Record<string, Record<string, string | number>[]>,
  rateLimit: RuntimeConfig["rateLimit"],
): Omit<ManagedOptionMaps, "responsesApiModels" | "defaultUseAutoGroup"> {
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const groupRatio: Record<string, number> = {};
  const userUsableGroups: Record<string, string> = {
    auto: t("CORE.GROUPS.AUTO_LABEL"),
  };

  for (const group of mergedGroups) {
    groupRatio[group.name] = r4(group.ratio);
    if (!group.private) userUsableGroups[group.name] = group.description;
  }

  const autoGroups = [...mergedGroups]
    .filter((g) => !g.private)
    .sort((a, b) => a.ratio - b.ratio)
    .map((g) => g.name);

  const modelRatio: Record<string, number> = {};
  const completionRatio: Record<string, number> = {};
  const modelPrice: Record<string, number> = {};
  const imageRatio: Record<string, number> = {};
  const cacheRatio: Record<string, number> = {};
  const createCacheRatio: Record<string, number> = {};
  const audioRatio: Record<string, number> = {};
  const audioCompletionRatio: Record<string, number> = {};
  const modelQuotaType: Record<string, number> = {};
  const billingMode: Record<string, string> = {};
  const billingExpr: Record<string, string> = {};

  for (const [name, ratios] of mergedModels) {
    const mappedName = modelMapping?.[name] ?? name;
    const isPerRequest =
      ratios.quotaType !== undefined && ratios.quotaType >= 1;
    const isTiered = Boolean(ratios.billingExpr);
    if (
      (ratios.modelPrice !== undefined && ratios.modelPrice > 0) ||
      isPerRequest
    ) {
      modelPrice[mappedName] = r4(ratios.modelPrice ?? 0);
    } else if (!isTiered) {
      modelRatio[mappedName] = r4(ratios.ratio);
      completionRatio[mappedName] = r4(ratios.completionRatio);
    }
    if (ratios.imageRatio !== undefined && ratios.imageRatio > 0)
      imageRatio[mappedName] = r4(ratios.imageRatio);
    if (ratios.cacheRatio !== undefined && ratios.cacheRatio >= 0)
      cacheRatio[mappedName] = r4(ratios.cacheRatio);
    if (ratios.createCacheRatio !== undefined && ratios.createCacheRatio >= 0)
      createCacheRatio[mappedName] = r4(ratios.createCacheRatio);
    if (ratios.audioRatio !== undefined && ratios.audioRatio > 0)
      audioRatio[mappedName] = r4(ratios.audioRatio);
    if (
      ratios.audioCompletionRatio !== undefined &&
      ratios.audioCompletionRatio > 0
    )
      audioCompletionRatio[mappedName] = r4(ratios.audioCompletionRatio);
    if (ratios.quotaType !== undefined && ratios.quotaType >= 1)
      modelQuotaType[mappedName] = ratios.quotaType;
    if (isTiered) {
      billingExpr[mappedName] = ratios.billingExpr!;
      billingMode[mappedName] = ratios.billingMode ?? "tiered_expr";
    }
  }

  // Pricing is global per model name (new-api has no per-channel price), so a grid
  // and a per-request provider of the same model cannot coexist cleanly. Collapse
  // every config grid to a single flat per-request modelPrice = the most expensive
  // grid row, so all groups bill one consistent, never-underbilling price. No
  // ModelGridPricing is emitted (the map stays empty, clearing any stale grid).
  const modelGridPricing: Record<string, GridPricingInfo> = {};
  for (const [modelName, rows] of Object.entries(configGridPricing)) {
    const mappedName = modelMapping?.[modelName] ?? modelName;
    const maxPricing = rows.reduce((max, row) => {
      const p = Number(row.Pricing);
      return Number.isFinite(p) && p > max ? p : max;
    }, 0);
    if (maxPricing > 0) {
      modelPrice[mappedName] = r4(maxPricing);
      delete modelRatio[mappedName];
      delete completionRatio[mappedName];
    }
  }

  const modelRateLimits = expandRateLimitModels(mergedModels.keys(), rateLimit);

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
    audioRatio,
    audioCompletionRatio,
    modelQuotaType,
    modelGridPricing,
    billingMode,
    billingExpr,
    modelRateLimits,
    rateLimitNewUserFactor: rateLimit?.newUserFactor ?? 1,
    rateLimitNewUserMaxAgeDays: rateLimit?.newUserMaxAgeDays ?? 0,
    rateLimitNewUserMaxUsedQuota: rateLimit?.newUserMaxUsedQuota ?? 0,
  };
}
