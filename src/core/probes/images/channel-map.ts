import type { ClientContext } from "@core/vendors/newapi/context";
import { listChannels } from "@core/vendors/newapi/resources";
import type { Channel } from "@core/types";

/**
 * Build a `model name -> channels[]` index from the provider's `/api/channel/`
 * listing. Disabled channels (`status !== 1`) are excluded so the probe
 * never tries to hit them. Channels are returned in the order new-api
 * gives us; sorting by priority/weight is the caller's responsibility (per
 * probe loop in the orchestrator).
 *
 * `channel.models` is a comma-separated string of model names. Some new-api
 * builds emit it with whitespace around the commas; normalise both.
 */
export async function buildChannelMap(
  ctx: ClientContext,
): Promise<Map<string, Channel[]>> {
  const channels = await listChannels(ctx);
  const map = new Map<string, Channel[]>();
  for (const ch of channels) {
    if (ch.status !== 1) continue;
    if (!ch.models) continue;
    const modelList = ch.models
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const m of modelList) {
      const arr = map.get(m);
      if (arr) arr.push(ch);
      else map.set(m, [ch]);
    }
  }
  return map;
}

/**
 * Channel sort comparator used by the probe orchestrator. Higher priority
 * channels first (so we test the user's preferred routing first), tiebreaker
 * by weight desc, then by id asc for determinism.
 */
export function compareChannelsForProbe(a: Channel, b: Channel): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa;
  const wa = a.weight ?? 0;
  const wb = b.weight ?? 0;
  if (wa !== wb) return wb - wa;
  return (a.id ?? 0) - (b.id ?? 0);
}
