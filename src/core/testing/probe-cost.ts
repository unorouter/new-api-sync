import {
  QUOTA_PER_USD,
  fetchUpstreamConsumeLogs,
} from "@core/sync/reconcile/upstream-logs";
import type { ClientContext } from "@core/vendors/newapi/context";
import { probeIdsSentSince } from "./probe-ids";

// A balance delta over a run also counts customer traffic on our lanes at that
// relay, so the cost is summed from the relay's own rows for our probe ids.
export async function measureProbeCost(
  ctx: ClientContext,
  since: number,
): Promise<{ cost: number; billed: number } | null> {
  const ids = probeIdsSentSince(since);
  if (ids.size === 0) return { cost: 0, billed: 0 };
  const logs = await fetchUpstreamConsumeLogs(ctx, {
    start: since,
    end: Math.floor(Date.now() / 1000) + 60,
  });
  if (logs.status.status !== "ok" || logs.incomplete) return null;
  let quota = 0;
  let billed = 0;
  for (const row of logs.rows) {
    if (!row.request_id || !ids.has(row.request_id)) continue;
    quota += row.quota;
    billed++;
  }
  return { cost: quota / QUOTA_PER_USD, billed };
}
