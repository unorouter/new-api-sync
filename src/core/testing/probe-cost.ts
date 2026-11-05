import {
  QUOTA_PER_USD,
  fetchUpstreamConsumeLogs,
} from "@core/sync/reconcile/upstream-logs";
import type { VerdictStore } from "@core/infra/verdict-store";
import type { ClientContext } from "@core/vendors/newapi/context";
import { t } from "@server/i18n";
import { consola } from "consola";
import { probeIdsSentSince } from "./probe-ids";

const SI_COST_HEADER = "x-si-buyer-cost-micro";

const replyCosts: { at: number; host: string; usd: number }[] = [];
const pendingLedger: string[] = [];

// One store object per UTC day: every measured provider cost of every job.
const ledgerObject = (at: number) =>
  `probe-cost/${new Date(at).toISOString().slice(0, 10)}.jsonl`;

export function recordProbeCostLine(
  provider: string,
  source: string,
  probe: { cost: number; billed: number },
): void {
  pendingLedger.push(
    JSON.stringify({
      at: Math.floor(Date.now() / 1000),
      provider,
      source,
      cost: probe.cost,
      billed: probe.billed,
    }),
  );
}

export async function flushProbeCosts(
  store: VerdictStore | null,
): Promise<void> {
  if (!store || pendingLedger.length === 0) return;
  const lines = pendingLedger.splice(0);
  try {
    await store.appendText(
      ledgerObject(Date.now()),
      lines,
      "application/x-ndjson",
    );
  } catch (err) {
    pendingLedger.unshift(...lines);
    consola.warn(
      t("CORE.PROBE_IDS.COST_PUSH_FAILED", {
        store: store.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function usageCost(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as { cost?: unknown; buyer_cost_micro?: unknown };
  if (typeof u.buyer_cost_micro === "number") return u.buyer_cost_micro / 1e6;
  if (typeof u.cost === "number") return u.cost;
  return null;
}

function bodyCost(text: string): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "usage" in parsed)
      return usageCost(parsed.usage);
  } catch {
    // An SSE body carries the usage on one of its last frames.
  }
  let last: number | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
    try {
      const frame: unknown = JSON.parse(line.slice(5).trim());
      if (frame && typeof frame === "object" && "usage" in frame)
        last = usageCost(frame.usage) ?? last;
    } catch {
      continue;
    }
  }
  return last;
}

// Marketplaces bill each reply and say so in it (InferHub `usage.cost`,
// Surplus Intelligence `usage.buyer_cost_micro` and a header).
export function recordReplyCost(
  host: string,
  headers: Headers,
  bodyText: string,
): void {
  const header = headers.get(SI_COST_HEADER);
  const usd =
    header !== null && header !== "" && Number.isFinite(Number(header))
      ? Number(header) / 1e6
      : bodyCost(bodyText);
  if (usd !== null && usd > 0)
    replyCosts.push({ at: Math.floor(Date.now() / 1000), host, usd });
}

export function replyCostSince(
  host: string,
  since: number,
): { cost: number; billed: number } {
  let cost = 0;
  let billed = 0;
  for (const r of replyCosts) {
    if (r.host !== host || r.at < since) continue;
    cost += r.usd;
    billed++;
  }
  return { cost, billed };
}

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
