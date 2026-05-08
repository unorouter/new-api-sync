import type { UpstreamPricing } from "@core/vendors/newapi/types";

/**
 * Pseudo-channel for the image probe: a routing bucket on the upstream
 * keyed by group name. Each group is a separate routing target on
 * new-api - the bearer's token group decides which upstream channel pool
 * gets used. The probe labels this the model's "channel" in results.
 *
 * Why groups instead of channel ids: most reseller new-api instances
 * forbid `/api/channel/` to non-admin keys (returns success:false). The
 * pricing endpoint, by contrast, is publicly readable and lists every
 * model's `enable_groups`. We use that as the routing surface.
 *
 * The actual inference api key is resolved LAZILY by ProbeTokenManager
 * the first time a group is probed, so providers that rate-limit
 * /api/token/{id}/key only fail at probe time (per-group), not at
 * startup (whole-provider).
 */
export interface GroupChannel {
  groupName: string;
  /** Group's pricing multiplier (groupRatios[groupName]). Lower = cheaper.
   *  Defaults to 1.0 when absent (legacy V2 pricing without explicit
   *  ratios). Used to order probe attempts cheapest-first so a passing
   *  cheap group settles the model before we burn quota on premium tiers.
   */
  groupRatio: number;
}

/**
 * Build a `model name -> GroupChannel[]` index from pricing alone. Each
 * entry lists every group that exposes the model. The probe loop
 * iterates these as if they were channels and calls
 * ProbeTokenManager.getApiKey(group) per attempt.
 */
export function buildGroupMap(
  pricing: UpstreamPricing,
): Map<string, GroupChannel[]> {
  const map = new Map<string, GroupChannel[]>();
  for (const m of pricing.models) {
    const channels: GroupChannel[] = (m.groups ?? []).map((groupName) => ({
      groupName,
      groupRatio: pricing.groupRatios[groupName] ?? 1,
    }));
    if (channels.length > 0) map.set(m.name, channels);
  }
  return map;
}

/**
 * Probe-order comparator: cheapest group first, alpha as deterministic
 * tiebreaker. This way the very first probe attempt for a model goes
 * through the cheapest pricing tier the upstream offers - if it passes,
 * the more expensive groups never get touched. If a model has the same
 * ratio across all groups, ordering falls back to group name.
 */
export function compareGroupChannels(a: GroupChannel, b: GroupChannel): number {
  if (a.groupRatio !== b.groupRatio) return a.groupRatio - b.groupRatio;
  return a.groupName.localeCompare(b.groupName);
}
