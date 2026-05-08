import type { UpstreamPricing } from "@core/vendors/newapi/types";

/**
 * Pseudo-channel: a (groupName, inferenceTokenKey) pair the probe submits
 * with. Each group is a separate routing bucket on new-api - the bearer's
 * token group decides which upstream channel pool gets used. We label this
 * the model's "channel" in results so the user can see which group worked.
 *
 * Why groups instead of channel ids: most reseller new-api instances forbid
 * `/api/channel/` to non-admin keys (returns success:false). The pricing
 * endpoint, by contrast, is publicly readable and lists every model's
 * `enable_groups`. We use that as the routing surface - one probe per
 * (model, group) pair, using the per-group token created via ensureTokens.
 */
export interface GroupChannel {
  groupName: string;
  apiKey: string;
}

/**
 * Build a `model name -> GroupChannel[]` index from pricing + a per-group
 * token map. Each entry lists every group that exposes the model, paired
 * with the inference token bound to that group. The probe loop iterates
 * these as if they were channels.
 */
export function buildGroupMap(
  pricing: UpstreamPricing,
  tokensByGroup: Record<string, string>,
): Map<string, GroupChannel[]> {
  const map = new Map<string, GroupChannel[]>();
  for (const m of pricing.models) {
    const channels: GroupChannel[] = [];
    for (const group of m.groups ?? []) {
      const apiKey = tokensByGroup[group];
      if (!apiKey) continue;
      channels.push({ groupName: group, apiKey });
    }
    if (channels.length > 0) map.set(m.name, channels);
  }
  return map;
}

/**
 * Stable comparator: alpha by groupName so probes hit the same group first
 * across reruns (deterministic resume).
 */
export function compareGroupChannels(a: GroupChannel, b: GroupChannel): number {
  return a.groupName.localeCompare(b.groupName);
}
