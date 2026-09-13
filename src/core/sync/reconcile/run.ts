import type { RuntimeConfig } from "@core/config";
import { getConcurrencyGate } from "@core/infra/concurrency";
import { logsDir } from "@core/infra/paths";
import { VerdictStore } from "@core/infra/verdict-store";
import type { Channel } from "@core/types";
import type {
  A7ProviderConfig,
  ProviderConfig,
} from "@core/validations/config";
import { loadProbeIds } from "@core/testing/probe-ids";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  extendCoverage,
  loadUpstreamCache,
  rowsInWindow,
  saveUpstreamCache,
  uncoveredRange,
} from "./cache";
import {
  fetchGatewayErrorRows,
  fetchGatewayLogs,
  fetchGatewayLogsByUpstreamIds,
} from "./gateway-logs";
import { matchProvider } from "./match";
import { checkOpenRouterKeys } from "./openrouter";
import {
  channelsForProvider,
  isOurTokenName,
  laneChannelIds,
} from "./ownership";
import type {
  GatewayLogRow,
  ProviderEvidence,
  ProviderReconcile,
  ReconcileResult,
  UpstreamLogRow,
} from "./types";
import { fetchUpstreamConsumeLogs, fetchUpstreamTokens } from "./upstream-logs";
import { explicitWindow, makeWindow, parseSince } from "./window";

type RelayProvider = ProviderConfig | A7ProviderConfig;
const LOCAL_SAVE_MS = 10_000;
const REMOTE_SAVE_MS = 600_000;
const QUOTA_PER_USD = 500000;
const usd = (quota: number) => `$${(quota / QUOTA_PER_USD).toFixed(4)}`;
const when = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16);

function emptyProvider(p: RelayProvider): ProviderReconcile {
  return {
    name: p.name,
    type: p.type,
    channelIds: [],
    upstreamLogs: { status: "unavailable", error: "" },
    tokenList: { status: "unavailable", error: "" },
    upstreamIncomplete: false,
    upstream: { rows: 0, quota: 0 },
    matched: {
      byId: 0,
      byIdViaErrorRow: 0,
      byFallback: 0,
      byFallbackZeroTokens: 0,
      byFallbackLoose: 0,
      quota: 0,
    },
    leaks: [],
    leakSummary: {
      abandoned: { rows: 0, quota: 0 },
      probe: { rows: 0, quota: 0 },
      unexplained: { rows: 0, quota: 0 },
    },
    ourUnmatched: { rows: 0, quota: 0, sample: [] },
    ours: { rows: 0, quota: 0 },
    quotaDelta: 0,
    foreignTokens: [],
    sourceIps: [],
  };
}

// An ip seen on a row our gateway provably made (matched by request id) is a
// path of ours even when it is not an egress address: duck logs its own edge
// proxy, not the client. Only an ip that appears solely on unaccounted rows
// can be foreign.
function sourceIps(
  rows: UpstreamLogRow[],
  leakIds: Set<number>,
  egress: Set<string> | null,
): ProviderReconcile["sourceIps"] {
  const by = new Map<
    string,
    { rows: number; quota: number; confirmed: boolean }
  >();
  for (const r of rows) {
    if (!r.ip) continue;
    const s = by.get(r.ip) ?? { rows: 0, quota: 0, confirmed: false };
    s.rows++;
    s.quota += r.quota;
    if (!leakIds.has(r.id)) s.confirmed = true;
    by.set(r.ip, s);
  }
  return [...by.entries()]
    .map(([ip, s]) => ({
      ip,
      rows: s.rows,
      quota: s.quota,
      ours: egress ? egress.has(ip) || s.confirmed : s.confirmed ? true : null,
    }))
    .sort((a, b) => b.quota - a.quota);
}

async function reconcileProvider(
  p: RelayProvider,
  channels: Channel[],
  ourRows: GatewayLogRow[] | null,
  ourErrors: GatewayLogRow[],
  probeIds: Set<string>,
  window: { start: number; end: number },
  prefix: string,
  store: VerdictStore | null,
  egress: Set<string> | null,
  dbUrl: string | null,
): Promise<{ entry: ProviderReconcile; evidence: ProviderEvidence }> {
  const entry = emptyProvider(p);
  const evidence: ProviderEvidence = {
    name: p.name,
    leakRows: [],
    matchedViaError: [],
  };
  try {
    const mine = channelsForProvider(channels, p.name, p.baseUrl);
    entry.channelIds = mine.flatMap((c) => (c.id == null ? [] : [c.id]));
    const ctx = new NewApiClient(p, p.name).ctx;
    const cache = await loadUpstreamCache(p.name, store);
    const range = uncoveredRange(cache, window);
    if (range) {
      consola.info(
        t("CLI.RECONCILE.FETCHING", {
          name: p.name,
          start: when(range.start),
          end: when(range.end),
          cached: cache.rows.size,
        }),
      );
      // Checkpoint as the walk goes: the local file every few seconds, the
      // store every two minutes, so a 429 or a kill keeps every page fetched.
      let lastLocal = 0;
      let lastRemote = Date.now();
      const checkpoint = async (
        rows: UpstreamLogRow[],
        from: number | null,
      ) => {
        if (from === null) {
          for (const r of rows) cache.rows.set(r.id, r);
          return;
        }
        extendCoverage(
          cache,
          { start: Math.max(range.start, from), end: range.end },
          rows,
        );
        const now = Date.now();
        if (now - lastLocal < LOCAL_SAVE_MS) return;
        const remote = now - lastRemote >= REMOTE_SAVE_MS;
        await saveUpstreamCache(cache, store, { remote });
        lastLocal = now;
        if (remote) lastRemote = now;
      };
      const logs = await fetchUpstreamConsumeLogs(ctx, range, checkpoint);
      entry.upstreamLogs = logs.status;
      entry.upstreamIncomplete = logs.incomplete;
      if (logs.status.status === "ok") await saveUpstreamCache(cache, store);
    } else {
      entry.upstreamLogs = { status: "ok" };
      consola.info(
        t("CLI.RECONCILE.CACHED", { name: p.name, cached: cache.rows.size }),
      );
    }
    const upstreamRows = rowsInWindow(cache, window);
    entry.upstream = {
      rows: upstreamRows.length,
      quota: upstreamRows.reduce((n, r) => n + r.quota, 0),
    };

    const tokens = await fetchUpstreamTokens(ctx);
    entry.tokenList = tokens.status;

    const ids = new Set(entry.channelIds);
    const ours = ourRows ? ourRows.filter((r) => ids.has(r.channel_id)) : [];
    if (dbUrl) {
      const seen = new Set(ours.map((r) => r.id));
      const wanted = upstreamRows.flatMap((r) =>
        r.request_id ? [r.request_id] : [],
      );
      for (const r of await fetchGatewayLogsByUpstreamIds(dbUrl, wanted))
        if (!seen.has(r.id)) ours.push(r);
    }
    const ownConsume = ours.filter(
      (r) =>
        r.type === 2 &&
        r.created_at >= window.start &&
        r.created_at <= window.end,
    );
    entry.ours = {
      rows: ownConsume.length,
      quota: ownConsume.reduce((n, r) => n + r.quota, 0),
    };

    const isOurToken = (name: string) => isOurTokenName(p.type, name, prefix);
    const result = matchProvider({
      upstream: upstreamRows,
      ours,
      ourErrors,
      probeIds,
      window,
      laneNarrow:
        p.type === "a7" ? (name) => laneChannelIds(mine, name) : undefined,
      isOurToken,
      listedTokens:
        tokens.status.status === "ok"
          ? tokens.tokens.map((tk) => ({ id: tk.id, name: tk.name }))
          : null,
    });
    entry.foreignTokens = result.foreignTokens;
    entry.sourceIps = sourceIps(
      upstreamRows,
      new Set(ourRows ? result.evidence.leakRows.map((r) => r.id) : []),
      egress,
    );
    if (ourRows) {
      entry.matched = result.matched;
      entry.leaks = result.leaks;
      entry.leakSummary = result.leakSummary;
      entry.ourUnmatched = result.ourUnmatched;
      evidence.leakRows = result.evidence.leakRows;
      evidence.matchedViaError = result.evidence.matchedViaError;
    }
    entry.quotaDelta = entry.upstream.quota - entry.ours.quota;
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
  }
  return { entry, evidence };
}

export async function runReconcile(
  config: RuntimeConfig,
  opts: { since: string; from?: string; to?: string },
): Promise<ReconcileResult> {
  const window =
    opts.from !== undefined
      ? explicitWindow(opts.from, opts.to ?? "now")
      : makeWindow(parseSince(opts.since));
  const gate = getConcurrencyGate();
  const target = new NewApiClient(config.target, "target");
  const channels = await target.listChannels();
  const store = config.verdictStore
    ? new VerdictStore(config.verdictStore)
    : null;
  const egress = config.targetEgressIps
    ? new Set(config.targetEgressIps.map((ip) => ip.trim()))
    : null;
  const prefix = config.target.targetPrefix ?? "prod";
  const relays: RelayProvider[] = [];
  for (const p of config.providers)
    if (p.type === "newapi" || p.type === "a7") relays.push(p);

  let ourRows: GatewayLogRow[] | null = null;
  if (config.targetDb) {
    const ids = new Set<number>();
    for (const p of relays)
      for (const c of channelsForProvider(channels, p.name, p.baseUrl))
        if (c.id != null) ids.add(c.id);
    ourRows = await fetchGatewayLogs(config.targetDb.url, window, [...ids]);
  }
  const ourErrors = config.targetDb
    ? await fetchGatewayErrorRows(config.targetDb.url, window)
    : [];
  const probeIds = await loadProbeIds(store);

  const settled = await Promise.all(
    relays.map((p) =>
      gate.run(p.name, () =>
        reconcileProvider(
          p,
          channels,
          ourRows,
          ourErrors,
          probeIds,
          window,
          prefix,
          store,
          egress,
          config.targetDb?.url ?? null,
        ),
      ),
    ),
  );
  const openrouter = await Promise.all(
    config.providers.flatMap((p) =>
      p.type === "openrouter"
        ? [gate.run(p.name, () => checkOpenRouterKeys(p))]
        : [],
    ),
  );

  const providers = settled.map((s) => s.entry);
  const unavailable = providers
    .filter((p) => p.upstreamLogs.status !== "ok" || p.error)
    .map((p) => p.name);
  const leak =
    providers.some(
      (p) =>
        p.leakSummary.unexplained.rows > 0 ||
        p.foreignTokens.some((tk) => tk.rows > 0) ||
        p.sourceIps.some((ip) => ip.ours === false),
    ) || openrouter.some((o) => o.foreignKeys.some((k) => (k.usage ?? 0) > 0));

  const result: ReconcileResult = {
    window: {
      ...window,
      since:
        opts.from !== undefined
          ? `${opts.from}..${opts.to ?? "now"}`
          : opts.since,
    },
    dbMode: config.targetDb ? "postgres" : "provider-only",
    providers,
    openrouter,
    unavailable,
    verdict: leak ? "leak" : "clean",
  };
  result.artifactPath = writeReconcileArtifact(
    result,
    settled.map((s) => s.evidence),
  );
  if (store) {
    try {
      await store.mirrorArtifact(result.artifactPath);
    } catch (err) {
      consola.warn(
        t("CORE.VERDICT_STORE.MIRROR_FAILED", {
          store: store.label,
          path: result.artifactPath,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return result;
}

function writeReconcileArtifact(
  result: ReconcileResult,
  evidence: ProviderEvidence[],
): string {
  const dir = logsDir();
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${ts}-reconcile.json`);
  writeFileSync(path, JSON.stringify({ ...result, evidence }, null, 2));
  return path;
}

export function printReconcileSummary(result: ReconcileResult): void {
  consola.info(
    t("CLI.RECONCILE.HEADER", {
      since: result.window.since,
      start: when(result.window.start),
      end: when(result.window.end),
    }),
  );
  if (result.dbMode === "provider-only") consola.warn(t("CLI.RECONCILE.NO_DB"));
  for (const p of result.providers) {
    if (p.error) {
      consola.error(
        t("CLI.RECONCILE.PROVIDER_ERROR", { name: p.name, error: p.error }),
      );
      continue;
    }
    if (p.upstreamLogs.status !== "ok") {
      consola.warn(
        t("CLI.RECONCILE.LOGS_UNAVAILABLE", {
          name: p.name,
          status: p.upstreamLogs.httpStatus ?? "-",
          error: p.upstreamLogs.error,
        }),
      );
      if (p.upstreamLogs.httpStatus === 403)
        consola.warn(t("CLI.RECONCILE.LOGS_403_HINT", { name: p.name }));
    } else {
      consola.info(
        t("CLI.RECONCILE.TOTALS", {
          name: p.name,
          upRows: p.upstream.rows,
          upQuota: usd(p.upstream.quota),
          ourRows: p.ours.rows,
        }),
      );
      if (p.upstreamIncomplete)
        consola.warn(t("CLI.RECONCILE.UPSTREAM_INCOMPLETE", { name: p.name }));
      if (p.channelIds.length === 0)
        consola.warn(t("CLI.RECONCILE.NO_CHANNELS", { name: p.name }));
      if (result.dbMode === "postgres") {
        consola.info(
          t("CLI.RECONCILE.MATCHED", {
            name: p.name,
            byId: p.matched.byId,
            viaError: p.matched.byIdViaErrorRow,
            fallback: p.matched.byFallback + p.matched.byFallbackZeroTokens,
            loose: p.matched.byFallbackLoose,
            quota: usd(p.matched.quota),
          }),
        );
        const ls = p.leakSummary;
        if (ls.abandoned.rows + ls.probe.rows + ls.unexplained.rows > 0)
          consola.info(
            t("CLI.RECONCILE.LEAK_SUMMARY", {
              name: p.name,
              abandoned: ls.abandoned.rows,
              abandonedQuota: usd(ls.abandoned.quota),
              probe: ls.probe.rows,
              probeQuota: usd(ls.probe.quota),
              unexplained: ls.unexplained.rows,
              unexplainedQuota: usd(ls.unexplained.quota),
            }),
          );
        for (const g of p.leaks.filter((g) => g.kind === "unexplained"))
          consola.warn(
            t(
              g.foreignToken
                ? "CLI.RECONCILE.LEAK_FOREIGN"
                : "CLI.RECONCILE.LEAK",
              {
                name: p.name,
                token: g.tokenName,
                model: g.model,
                rows: g.rows,
                quota: usd(g.quota),
                first: when(g.first),
                last: when(g.last),
              },
            ),
          );
        if (p.ourUnmatched.rows > 0)
          consola.info(
            t("CLI.RECONCILE.OUR_UNMATCHED", {
              name: p.name,
              rows: p.ourUnmatched.rows,
              quota: usd(p.ourUnmatched.quota),
            }),
          );
      }
    }
    if (p.tokenList.status !== "ok")
      consola.warn(
        t("CLI.RECONCILE.TOKENS_UNAVAILABLE", {
          name: p.name,
          status: p.tokenList.httpStatus ?? "-",
          error: p.tokenList.error,
        }),
      );
    for (const ip of p.sourceIps) {
      const params = {
        name: p.name,
        ip: ip.ip,
        rows: ip.rows,
        quota: usd(ip.quota),
      };
      if (ip.ours === false)
        consola.error(t("CLI.RECONCILE.FOREIGN_IP", params));
      else consola.info(t("CLI.RECONCILE.SOURCE_IP", params));
    }
    if (p.upstreamLogs.status === "ok" && p.sourceIps.length === 0)
      consola.info(t("CLI.RECONCILE.NO_IPS", { name: p.name }));
    for (const tk of p.foreignTokens) {
      const params = {
        name: p.name,
        token: tk.name,
        rows: tk.rows,
        quota: usd(tk.quota),
      };
      if (!tk.exists)
        consola.error(t("CLI.RECONCILE.FOREIGN_TOKEN_DELETED", params));
      else if (tk.rows > 0)
        consola.error(t("CLI.RECONCILE.FOREIGN_TOKEN", params));
      else consola.warn(t("CLI.RECONCILE.FOREIGN_TOKEN_IDLE", params));
    }
  }
  for (const o of result.openrouter) {
    if (o.status === "no-management-key")
      consola.info(t("CLI.RECONCILE.OPENROUTER_NO_MGMT", { name: o.name }));
    else if (o.status === "error")
      consola.warn(
        t("CLI.RECONCILE.PROVIDER_ERROR", {
          name: o.name,
          error: o.error ?? "",
        }),
      );
    else if (o.foreignKeys.length === 0)
      consola.info(t("CLI.RECONCILE.OPENROUTER_CLEAN", { name: o.name }));
    for (const k of o.foreignKeys) {
      const line = t("CLI.RECONCILE.OPENROUTER_FOREIGN_KEY", {
        name: o.name,
        key: k.name || k.hash || "?",
        usage: (k.usage ?? 0).toFixed(4),
        daily: (k.usageDaily ?? 0).toFixed(4),
        disabled: k.disabled ? "disabled" : "enabled",
      });
      if ((k.usage ?? 0) > 0) consola.error(line);
      else consola.warn(line);
    }
  }
  if (result.artifactPath)
    consola.info(
      t("CLI.RECONCILE.ARTIFACT_WRITTEN", { path: result.artifactPath }),
    );
  if (result.verdict === "clean")
    consola.success(
      t("CLI.RECONCILE.CLEAN", {
        unavailable:
          result.unavailable.length > 0 ? result.unavailable.join(", ") : "-",
      }),
    );
  else consola.error(t("CLI.RECONCILE.LEAK_VERDICT"));
}
