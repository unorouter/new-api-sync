import { inferModelType } from "@core/catalog/constants/inference";
import type { RuntimeConfig } from "@core/config";
import { isFixed } from "@core/pricing/compute";
import { parseJsonObject } from "@core/sync/option-store";
import type {
  GridPricingInfo,
  ManagedOptionMaps,
  MergedGroup,
  MergedModel,
} from "@core/types";
import { t } from "@server/i18n";
import micromatch from "micromatch";

// Groups that still have an enabled channel in the target, with the labels/ratios
// already published for them, so a run that failed to re-offer one can restore it
// instead of letting the prune drop it.
export interface SurvivingGroups {
  labels: Map<string, string>;
  ratios: Map<string, number>;
}

export function buildSurvivingGroups(
  channels: { group?: string; status?: number }[],
  options: Record<string, string>,
): SurvivingGroups {
  const publishedLabels = parseJsonObject(options["UserUsableGroups"]);
  const publishedRatios = parseJsonObject(options["GroupRatio"]);

  const labels = new Map<string, string>();
  const ratios = new Map<string, number>();
  for (const ch of channels) {
    if (ch.status !== 1) continue;
    for (const raw of (ch.group ?? "").split(",")) {
      const g = raw.trim();
      // Only groups the gateway ALREADY published: this restores what a blip
      // dropped, it does not publish a group that was never user-visible.
      if (!g) continue;
      const label = publishedLabels[g];
      if (typeof label !== "string") continue;
      labels.set(g, label);
      const ratio = publishedRatios[g];
      if (typeof ratio === "number") ratios.set(g, ratio);
    }
  }
  return { labels, ratios };
}

// Per-model rate limits apply ONLY to `:free` published names; paid models are
// never limited. Two layers: `modality` is the default cap per model type
// (resolved by inferModelType so new models inherit with no config edit), and
// `models` globs OVERRIDE it (first match wins, config order). A name with
// neither a modality default nor a glob match stays unlimited.
export function expandRateLimitModels(
  names: Iterable<string>,
  rateLimit: RuntimeConfig["rateLimit"],
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const modality = rateLimit?.modality;
  const globs = Object.entries(rateLimit?.models ?? {});
  if (!modality && globs.length === 0) return out;
  for (const name of names) {
    if (!name.endsWith(":free")) continue;
    // 1. modality default (unknown -> text, which inferModelType returns for
    //    unrecognized names). Strip :free so classification is name-based.
    const type = inferModelType(name.slice(0, -":free".length));
    let limits = modality?.[type] ?? modality?.text;
    // 2. glob override wins.
    for (const [glob, g] of globs) {
      if (micromatch.isMatch(name, glob)) {
        limits = g;
        break;
      }
    }
    if (!limits) continue;
    // Gateway option format is [totalAttempts, successCount] or
    // [totalAttempts, successCount, windowMinutes].
    out[name] = limits.windowMinutes
      ? [limits.total ?? 0, limits.success, limits.windowMinutes]
      : [limits.total ?? 0, limits.success];
  }
  return out;
}

export function buildOptionMaps(
  mergedGroups: MergedGroup[],
  mergedModels: Map<string, MergedModel>,
  modelMapping: Record<string, string>,
  configGridPricing: Record<string, Record<string, string | number>[]>,
  rateLimit: RuntimeConfig["rateLimit"],
  survivingGroups?: SurvivingGroups,
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

  // A group only enters the maps above when THIS run produced an offer for it, and
  // the prune then drops anything absent. So a lane whose upstream merely blipped
  // (an OpenRouter host under the old uptime floor, a free tier throttling mid-probe)
  // lost its visibility and never got it back once the upstream recovered - the
  // removal was one-way. Re-assert groups that still have an enabled channel so a
  // transient miss costs nothing permanent.
  const recovered: string[] = [];
  for (const [name, label] of survivingGroups?.labels ?? []) {
    if (name in userUsableGroups) continue;
    userUsableGroups[name] = label;
    recovered.push(name);
    groupRatio[name] ??= survivingGroups?.ratios.get(name) ?? 1;
  }

  const autoGroups = [
    ...[...mergedGroups].map((g) => g.name),
    ...recovered,
  ].sort((a, b) => (groupRatio[a] ?? 1) - (groupRatio[b] ?? 1));

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
    const isTiered = Boolean(ratios.billingExpr);
    if (isFixed(ratios)) {
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

  // Two grid shapes, handled differently:
  // - Resolution grid (rows keyed on "Resolution", e.g. gemini-image 1K/2K/4K): the gateway
  //   applies it at settlement via GetGridPrice(model, ImageResolution), so emit the real
  //   ModelGridPricing. A per-request modelPrice base is still set (the cheapest tier) so a
  //   request without a resolution falls back sanely.
  // - Duration/mode grid (wan/sora config grids): the video task adaptor derives seconds/mode
  //   from the request, so a settlement grid would double-count. Collapse to a flat max-price
  //   modelPrice (never-underbilling), emit no grid.
  const modelGridPricing: Record<string, GridPricingInfo> = {};
  for (const [modelName, rows] of Object.entries(configGridPricing)) {
    const mappedName = modelMapping?.[modelName] ?? modelName;
    const isResolutionGrid = rows.every(
      (row) => typeof row.Resolution === "string" && row.Resolution !== "",
    );
    if (isResolutionGrid && rows.length > 0) {
      modelGridPricing[mappedName] = rows as GridPricingInfo;
      const minPricing = rows.reduce((min, row) => {
        const p = Number(row.Pricing);
        return Number.isFinite(p) && p > 0 && p < min ? p : min;
      }, Infinity);
      if (Number.isFinite(minPricing)) {
        modelPrice[mappedName] = r4(minPricing);
        delete modelRatio[mappedName];
        delete completionRatio[mappedName];
      }
      continue;
    }
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
  };
}
