import { parseModelList } from "@core/catalog/constants/patterns";
import { isRoutingOnlyAlias } from "@core/sync/pipeline/desired-models";
import type { Channel } from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
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

/**
 * GUEST_API_KEY: refresh token's model_limits from the FULL served `:free`
 * catalog. No-op when unset.
 *
 * Derived from every channel's published names, not from the run's priced plan:
 * `model_limits` is a wholesale overwrite, so computing it from one run's scope
 * silently evicted every free model outside it. A `--only qwen1` run dropped 175
 * live free models (claude-sonnet-5, the whole image catalog, grok) and each one
 * then 403'd with "This token has no access to model ...".
 *
 * Status-agnostic on purpose, matching the metadata path: a free model whose
 * channel is currently disabled or banned stays allowed so it works the instant
 * the channel recovers. Listing a model that cannot serve costs nothing - it
 * fails at routing instead of at auth.
 */
export async function updateGuestTokenIfConfigured(
  target: NewApiClient,
  channels: Channel[],
): Promise<GuestTokenUpdateResult> {
  return updateGuestTokenFromNames(target, collectFreeNames(channels));
}

/** Every published `:free` name across all channels, regardless of status. */
export function collectFreeNames(channels: Channel[]): string[] {
  const names = new Set<string>();
  for (const ch of channels)
    for (const name of parseModelList(ch.models))
      if (name.endsWith(":free") && !isRoutingOnlyAlias(name)) names.add(name);
  return [...names].sort();
}

/**
 * GUEST_API_KEY: refresh the token's model_limits from a set of PUBLISHED names,
 * keeping every `:free` name regardless of whether its channel is currently
 * enabled, auto-disabled, or banned. Used by `sync metadata`, which has no priced
 * plan but knows the served `:free` catalog; a temporarily-down free model stays
 * allowed so it works the moment its channel recovers, without a full re-sync.
 * No-op when GUEST_API_KEY is unset or the token is not found.
 */
export async function updateGuestTokenFromNames(
  target: NewApiClient,
  freeNames: string[],
): Promise<GuestTokenUpdateResult> {
  const guestKey = Bun.env.GUEST_API_KEY;
  if (!guestKey) return SKIPPED;

  const token = await target.findTokenByKey(guestKey);
  if (!token) return SKIPPED;

  const modelLimits = freeNames.join(",");
  const ok = await target.updateTokenModelLimits(token, modelLimits);
  if (!ok) return { configured: true, updated: false, freeModelCount: 0 };

  consola.info(
    t("CORE.NEWAPI.GUEST_TOKEN_UPDATED", {
      name: token.name,
      count: freeNames.length,
    }),
  );
  return { configured: true, updated: true, freeModelCount: freeNames.length };
}
