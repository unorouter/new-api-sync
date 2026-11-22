import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import consola from "consola";
import type { Channel } from "@core/types";
import type { VerdictStore } from "@core/infra/verdict-store";
import { logsDir } from "@core/infra/paths";
import { t } from "@server/i18n";
import { fetchLaneStats, type LaneStat } from "./lane-stats";
import type { QuarantineLedger } from "./lane-grader";

/** One lane's real traffic over one UTC day, next to the probes' observe log. */
export interface RollupRow extends LaneStat {
  day: string;
  name: string | null;
  provider: string | null;
  status: number | null;
  /** The observe log's key for the same lane, where the name allows deriving it. */
  laneKey: string | null;
  quarantined: boolean;
}

const DAY_S = 86_400;
const rollupPath = (day: string) =>
  join(logsDir(), "lane-stats", `${day}.jsonl`);
const rollupObject = (day: string) => `lane-stats/${day}.jsonl`;

// a7-<supplier>-<merchant>-<model>, si-<model>, ih-<pool>-<model>; the observe
// keys are a7:<merchant>|<model>, si|<model>, ih|<pool>/<model>. The tag is the
// provider name and its adaptor type picks the shape.
export function laneKeyOf(
  ch: Channel,
  typeOf: ReadonlyMap<string, string>,
): string | null {
  const model = ch.models.split(",")[0]?.trim() ?? "";
  const tag = ch.tag ?? "";
  const type = typeOf.get(tag);
  if (type === "a7") {
    const prefix = ch.name.endsWith(`-${model}`)
      ? ch.name.slice(0, -(model.length + 1))
      : ch.name;
    const m = /-(\d{2,6})$/.exec(prefix);
    return m ? `${tag}:${m[1]}|${model}` : null;
  }
  if (type === "si") return `${tag}|${model}`;
  if (type === "ih") {
    const rest = ch.name.startsWith(`${tag}-`)
      ? ch.name.slice(tag.length + 1)
      : "";
    const dash = rest.indexOf("-");
    return dash > 0 ? `${tag}|${rest.slice(0, dash)}/${model}` : null;
  }
  return `${ch.tag ?? ch.name}|${model}`;
}

export function rollupRows(
  day: string,
  stats: readonly LaneStat[],
  channels: readonly Channel[],
  ledger: QuarantineLedger,
  typeOf: ReadonlyMap<string, string>,
): RollupRow[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const out = new Set(ledger.active.map((e) => e.channelId));
  return stats.map((s) => {
    const ch = byId.get(s.channelId);
    return {
      ...s,
      day,
      name: ch?.name ?? null,
      provider: ch?.tag ?? null,
      status: ch?.status ?? null,
      laneKey: ch ? laneKeyOf(ch, typeOf) : null,
      quarantined: out.has(s.channelId),
    };
  });
}

/** Yesterday's rollup, once: the first tick of a UTC day writes it. */
export async function writeDailyRollupIfDue(
  url: string,
  channels: readonly Channel[],
  ledger: QuarantineLedger,
  store: VerdictStore | null,
  typeOf: ReadonlyMap<string, string>,
): Promise<void> {
  const todayStart = Math.floor(Date.now() / 1000 / DAY_S) * DAY_S;
  const day = new Date((todayStart - DAY_S) * 1000).toISOString().slice(0, 10);
  if (existsSync(rollupPath(day))) return;
  if (store && (await store.readText(rollupObject(day))) !== null) return;
  const stats = await fetchLaneStats(url, todayStart - DAY_S, todayStart);
  const rows = rollupRows(day, stats, channels, ledger, typeOf);
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  mkdirSync(join(logsDir(), "lane-stats"), { recursive: true });
  writeFileSync(rollupPath(day), body);
  if (store)
    await store.writeText(rollupObject(day), body, "application/x-ndjson");
  consola.info(
    t("CORE.LANE_GRADER.ROLLUP_WRITTEN", { day, lanes: rows.length }),
  );
}

/** A written rollup, local first, then the store. */
export async function readRollup(
  day: string,
  store: VerdictStore | null,
): Promise<RollupRow[] | null> {
  const local = existsSync(rollupPath(day))
    ? readFileSync(rollupPath(day), "utf8")
    : null;
  const text =
    local ?? (store ? await store.readText(rollupObject(day)) : null);
  if (text === null) return null;
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l): RollupRow => JSON.parse(l));
}
