import type { NewApiClient } from "@core/vendors/newapi/client";
import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { t } from "@server/i18n";
import { consola } from "consola";

export interface GuestTokenUpdateResult {
  configured: boolean;
  updated: boolean;
  freeModelCount: number;
}

const SKIPPED: GuestTokenUpdateResult = {
  configured: false,
  updated: false,
  freeModelCount: 0,
};

/**
 * If `GUEST_API_KEY` is set in the environment, refresh the matching token's
 * `model_limits` so it only exposes models that are zero-priced in *every*
 * group they appear in. Silent no-op when the env var is unset or the token
 * isn't found upstream.
 */
export async function updateGuestTokenIfConfigured(
  target: NewApiClient,
  pricing: UpstreamPricing,
): Promise<GuestTokenUpdateResult> {
  const guestKey = Bun.env.GUEST_API_KEY;
  if (!guestKey) return SKIPPED;

  const token = await target.findTokenByKey(guestKey);
  if (!token) return SKIPPED;

  const freeModels = collectTrulyFreeModels(pricing);
  const modelLimits = freeModels.join(",");
  const ok = await target.updateTokenModelLimits(token, modelLimits);
  if (!ok) return { configured: true, updated: false, freeModelCount: 0 };

  consola.info(
    t("CORE.NEWAPI.GUEST_TOKEN_UPDATED", {
      name: token.name,
      count: freeModels.length,
    }),
  );
  return { configured: true, updated: true, freeModelCount: freeModels.length };
}

/**
 * A model is "truly free" only if every group it appears in has a zero
 * upstream price. A model whose price is 0 in one group but >0 in another
 * is reachable cheaply via cross-group fallback but is not unconditionally
 * free, so it is excluded.
 */
function collectTrulyFreeModels(pricing: UpstreamPricing): string[] {
  const free: string[] = [];
  for (const model of pricing.models) {
    if (model.groups.length === 0) continue;
    const isFree = model.groups.every((g) => isGroupPriceZero(pricing, model, g));
    if (isFree) free.push(model.name);
  }
  free.sort();
  return free;
}

function isGroupPriceZero(
  pricing: UpstreamPricing,
  model: { name: string; ratio: number; modelPrice?: number; quotaType?: number },
  groupName: string,
): boolean {
  // Per-call pricing: model.modelPrice is only set by parsePricingV1 when the
  // upstream price is > 0, so any defined value here means the model charges
  // a flat per-call fee regardless of group ratio. Group ratio still scales
  // the cost, but a non-zero base * any group ratio > 0 is still non-free.
  if (model.modelPrice !== undefined && model.modelPrice > 0) return false;

  const groupRatio = pricing.groupRatios[groupName] ?? 1;
  if (groupRatio === 0) return true;

  const modelRatio = pricing.modelRatios[model.name] ?? model.ratio ?? 0;
  return modelRatio === 0;
}
