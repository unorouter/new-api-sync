import type { UpstreamPricing } from "@core/vendors/newapi/types";

/**
 * Pseudo-channel keyed by group: most resellers forbid /api/channel/ to
 * non-admin keys, but /api/pricing is public and lists each model's
 * enable_groups. The inference api key is resolved lazily per group.
 */
export interface GroupChannel {
  groupName: string;
  /** Pricing multiplier. Defaults to 1.0 (legacy V2 without explicit ratios). */
  groupRatio: number;
}

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

/** Cheapest-first; alpha tiebreaker for determinism. */
export function compareGroupChannels(a: GroupChannel, b: GroupChannel): number {
  if (a.groupRatio !== b.groupRatio) return a.groupRatio - b.groupRatio;
  return a.groupName.localeCompare(b.groupName);
}
