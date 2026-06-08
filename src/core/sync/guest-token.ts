import type { NewApiClient } from "@core/vendors/newapi/client";
import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { t } from "@server/i18n";
import { consola } from "consola";

interface GuestTokenUpdateResult {
  configured: boolean;
  updated: boolean;
  freeModelCount: number;
}

const SKIPPED: GuestTokenUpdateResult = {
  configured: false,
  updated: false,
  freeModelCount: 0,
};

/** GUEST_API_KEY: refresh token's model_limits to only-truly-free models. No-op when unset. */
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

/** Reachable free if ANY group is zero-priced. Guest has 0 balance so the paid groups are unreachable; listing the model only ever resolves to its free group. */
function collectTrulyFreeModels(pricing: UpstreamPricing): string[] {
  const free: string[] = [];
  for (const model of pricing.models) {
    if (model.groups.length === 0) continue;
    const isFree = model.groups.some((g) =>
      isGroupPriceZero(pricing, model, g),
    );
    if (isFree) free.push(model.name);
  }
  free.sort();
  return free;
}

function isGroupPriceZero(
  pricing: UpstreamPricing,
  model: {
    name: string;
    ratio: number;
    modelPrice?: number;
    quotaType?: number;
  },
  groupName: string,
): boolean {
  // Any per-call price > 0 is not free regardless of group ratio.
  if (model.modelPrice !== undefined && model.modelPrice > 0) return false;

  const groupRatio = pricing.groupRatios[groupName] ?? 1;
  if (groupRatio === 0) return true;

  const modelRatio = pricing.modelRatios[model.name] ?? model.ratio ?? 0;
  return modelRatio === 0;
}
