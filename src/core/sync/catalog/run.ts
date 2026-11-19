import { parseModelList } from "@core/catalog/constants/patterns";
import type { RuntimeConfig } from "@core/config";
import { logsDir } from "@core/infra/paths";
import type { Channel } from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import pLimit from "p-limit";
import {
  discoverCatalog,
  type CatalogRow,
  type ProviderCatalog,
  type UpstreamPrice,
} from "./discover";

const DISCOVERY_CONCURRENCY = 8;
const USD_PER_M_PER_RATIO = 2;

const OPTION_KEYS = [
  "GroupRatio",
  "ModelRatio",
  "CompletionRatio",
  "ModelPrice",
  "AutoGroups",
  "UserUsableGroups",
];

interface TargetState {
  channels: Channel[];
  byModel: Map<string, Channel[]>;
  groupRatio: Record<string, number>;
  modelRatio: Record<string, number>;
  completionRatio: Record<string, number>;
  modelPrice: Record<string, number>;
  autoGroups: Set<string>;
  usableGroups: Set<string>;
}

export interface CatalogLine {
  provider: string;
  upstream_group: string;
  upstream_model: string;
  published_name: string;
  upstream_in_per_m: string;
  upstream_out_per_m: string;
  config_state: string;
  our_channels: string;
  our_sell_in_per_m: string;
  our_sell_out_per_m: string;
  fallback_live_lanes: number;
  fallback_cheapest: string;
}

export interface CatalogSummaryLine {
  provider: string;
  type: string;
  discovered: number;
  enabled: number;
  filtered: number;
  with_live_channels: number;
  error: string;
}

export interface CatalogResult {
  path: string;
  summaryPath: string;
  rows: number;
  providers: number;
}

function parseOption(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function numberMap(raw: string | undefined): Record<string, number> {
  const parsed = parseOption(raw);
  const out: Record<string, number> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return out;
  for (const [k, v] of Object.entries(parsed))
    if (typeof v === "number") out[k] = v;
  return out;
}

// AutoGroups is a JSON array, UserUsableGroups a JSON object keyed by group.
function groupSet(raw: string | undefined): Set<string> {
  const parsed = parseOption(raw);
  if (Array.isArray(parsed))
    return new Set(parsed.filter((g): g is string => typeof g === "string"));
  if (parsed && typeof parsed === "object") return new Set(Object.keys(parsed));
  return new Set();
}

async function loadTarget(config: RuntimeConfig): Promise<TargetState> {
  const client = new NewApiClient(config.target, "target");
  const [channels, options] = await Promise.all([
    client.listChannels(),
    client.getOptions(OPTION_KEYS),
  ]);
  const byModel = new Map<string, Channel[]>();
  for (const ch of channels)
    for (const m of parseModelList(ch.models)) {
      let list = byModel.get(m);
      if (!list) byModel.set(m, (list = []));
      list.push(ch);
    }
  return {
    channels,
    byModel,
    groupRatio: numberMap(options.GroupRatio),
    modelRatio: numberMap(options.ModelRatio),
    completionRatio: numberMap(options.CompletionRatio),
    modelPrice: numberMap(options.ModelPrice),
    autoGroups: groupSet(options.AutoGroups),
    usableGroups: groupSet(options.UserUsableGroups),
  };
}

/** What the gateway bills for `model` on `ch`: the cheapest of its groups. */
function sellPrice(
  target: TargetState,
  ch: Channel,
  model: string,
): UpstreamPrice | undefined {
  const ratios = parseModelList(ch.group ?? "")
    .map((g) => target.groupRatio[g])
    .filter((r): r is number => r !== undefined);
  const groupRatio = ratios.length > 0 ? Math.min(...ratios) : 1;
  const fixed = target.modelPrice[model];
  if (fixed !== undefined) return { perCall: fixed * groupRatio };
  const ratio = target.modelRatio[model];
  if (ratio === undefined) return undefined;
  const inPerM = ratio * USD_PER_M_PER_RATIO * groupRatio;
  return {
    inPerM,
    outPerM: inPerM * (target.completionRatio[model] ?? 1),
  };
}

function sortKey(p: UpstreamPrice | undefined): number {
  return p?.inPerM ?? p?.perCall ?? Infinity;
}

function cheapest(
  target: TargetState,
  channels: Channel[],
  model: string,
): { ch: Channel; price: UpstreamPrice | undefined } | undefined {
  let best: { ch: Channel; price: UpstreamPrice | undefined } | undefined;
  for (const ch of channels) {
    const price = sellPrice(target, ch, model);
    if (!best || sortKey(price) < sortKey(best.price)) best = { ch, price };
  }
  return best;
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  return String(+n.toFixed(6));
}

function fmtIn(p: UpstreamPrice | undefined): string {
  if (p?.perCall !== undefined) return `${fmt(p.perCall)}/call`;
  return fmt(p?.inPerM);
}

function fmtOut(p: UpstreamPrice | undefined): string {
  return p?.perCall !== undefined ? "" : fmt(p?.outPerM);
}

function routable(target: TargetState, ch: Channel): boolean {
  const groups = parseModelList(ch.group ?? "");
  return groups.some(
    (g) => target.autoGroups.has(g) && target.usableGroups.has(g),
  );
}

function ourChannelsFor(target: TargetState, row: CatalogRow): Channel[] {
  const serving = target.byModel.get(row.publishedName) ?? [];
  if (row.channelName !== undefined)
    return serving.filter((ch) => ch.name === row.channelName);
  return serving.filter((ch) => ch.tag === row.provider);
}

function toLine(target: TargetState, row: CatalogRow): CatalogLine {
  const ours = ourChannelsFor(target, row);
  const live = ours.filter((ch) => ch.status === 1);
  const sell = cheapest(
    target,
    live.length > 0 ? live : ours,
    row.publishedName,
  );
  const fallbacks = (target.byModel.get(row.publishedName) ?? []).filter(
    (ch) => ch.status === 1 && ch.tag !== row.provider,
  );
  const fallback = cheapest(target, fallbacks, row.publishedName);
  const published = row.aliases.length
    ? `${row.publishedName} (+${row.aliases.join(",")})`
    : row.publishedName;
  return {
    provider: row.provider,
    upstream_group: row.upstreamGroup,
    upstream_model: row.upstreamModel,
    published_name: published,
    upstream_in_per_m: fmtIn(row.price),
    upstream_out_per_m: fmtOut(row.price),
    config_state: row.state,
    our_channels: ours
      .map(
        (ch) =>
          `${ch.id}:${ch.status}${ch.status === 1 && !routable(target, ch) ? ":unrouted" : ""}`,
      )
      .join(","),
    our_sell_in_per_m: fmtIn(sell?.price),
    our_sell_out_per_m: fmtOut(sell?.price),
    fallback_live_lanes: fallbacks.length,
    fallback_cheapest: fallback
      ? `${fallback.ch.name}@${fmtIn(fallback.price)}/${fmtOut(fallback.price)}`
      : "",
  };
}

function summarize(
  catalog: ProviderCatalog,
  lines: CatalogLine[],
  withLive: number,
): CatalogSummaryLine {
  const enabled = lines.filter((l) => l.config_state === "enabled").length;
  const note =
    catalog.note === "marketplace_skipped"
      ? t("CLI.CATALOG.MARKETPLACE_SKIPPED")
      : catalog.note === "declarative"
        ? t("CLI.CATALOG.DECLARATIVE")
        : "";
  return {
    provider: catalog.provider,
    type: catalog.type,
    discovered: lines.length,
    enabled,
    filtered: lines.filter(
      (l) => l.config_state !== "enabled" && l.config_state !== "declarative",
    ).length,
    with_live_channels: withLive,
    error: catalog.error ?? note,
  };
}

function cell(value: string | number): string {
  return String(value).replace(/[\t\r\n]+/g, " ");
}

function toTsv<T extends object>(columns: (keyof T)[], rows: T[]): string {
  const header = columns.map(String).join("\t");
  const body = rows.map((r) =>
    columns.map((c) => cell(String(r[c]))).join("\t"),
  );
  return [header, ...body].join("\n") + "\n";
}

const LINE_COLUMNS: (keyof CatalogLine)[] = [
  "provider",
  "upstream_group",
  "upstream_model",
  "published_name",
  "upstream_in_per_m",
  "upstream_out_per_m",
  "config_state",
  "our_channels",
  "our_sell_in_per_m",
  "our_sell_out_per_m",
  "fallback_live_lanes",
  "fallback_cheapest",
];

const SUMMARY_COLUMNS: (keyof CatalogSummaryLine)[] = [
  "provider",
  "type",
  "discovered",
  "enabled",
  "filtered",
  "with_live_channels",
  "error",
];

/** Read only: provider listings and the target's channels and options, written to one flat file. */
export async function runCatalog(
  config: RuntimeConfig,
  opts: { out?: string; json?: boolean },
): Promise<CatalogResult> {
  const target = await loadTarget(config);
  const limit = pLimit(DISCOVERY_CONCURRENCY);
  const catalogs = await Promise.all(
    config.providers.map((pc) => limit(() => discoverCatalog(pc, config))),
  );

  const lines: CatalogLine[] = [];
  const summary: CatalogSummaryLine[] = [];
  for (const catalog of catalogs) {
    const providerLines = catalog.rows.map((r) => toLine(target, r));
    lines.push(...providerLines);
    const withLive = catalog.rows.filter((r) =>
      ourChannelsFor(target, r).some((ch) => ch.status === 1),
    ).length;
    summary.push(summarize(catalog, providerLines, withLive));
    if (catalog.note === "marketplace_skipped")
      consola.info(
        t("CLI.CATALOG.SKIPPED_LINE", {
          name: catalog.provider,
          reason: t("CLI.CATALOG.MARKETPLACE_SKIPPED"),
        }),
      );
    if (catalog.error)
      consola.warn(
        t("CLI.CATALOG.DISCOVERY_FAILED", {
          name: catalog.provider,
          error: catalog.error,
        }),
      );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = opts.json ? "json" : "tsv";
  const path = opts.out ?? join(logsDir(), `catalog-${stamp}.${ext}`);
  const summaryPath = path.replace(/\.(tsv|json)$/, "") + `-summary.${ext}`;
  await mkdir(dirname(path), { recursive: true });
  if (opts.json) {
    await Bun.write(
      path,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), rows: lines },
        null,
        1,
      ),
    );
    await Bun.write(summaryPath, JSON.stringify(summary, null, 1));
  } else {
    await Bun.write(path, toTsv(LINE_COLUMNS, lines));
    await Bun.write(summaryPath, toTsv(SUMMARY_COLUMNS, summary));
  }
  return { path, summaryPath, rows: lines.length, providers: catalogs.length };
}
