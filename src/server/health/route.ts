import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyOnlyProviders, loadConfig } from "@core/config";
import { configPath, listConfigs } from "@server/config/route";
import { listActiveRuns } from "@server/sse";
import { Elysia, t } from "elysia";
import pkg from "../../../package.json" with { type: "json" };

const LOGS_DIR = "logs";
const TEST_FILE_RE = /^(.+)-model-tests\.json$/;
const KIRO_FILE = "kiro-blacklist.json";

const ProviderCountsSchema = t.Object({
  newapi: t.Number(),
  sub2api: t.Number(),
  direct: t.Number(),
  nvidia: t.Number(),
  total: t.Number(),
});

const LastRunSchema = t.Union([
  t.Object({
    id: t.String(),
    timestamp: t.String(),
    total: t.Number(),
    passed: t.Number(),
    failed: t.Number(),
  }),
  t.Null(),
]);

const ResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    ok: t.Boolean(),
    version: t.String(),
    uptime: t.Number(),
    startedAt: t.String(),
    runtime: t.Object({
      bun: t.String(),
      platform: t.String(),
      arch: t.String(),
      pid: t.Number(),
    }),
    memory: t.Object({
      rss: t.Number(),
      heapUsed: t.Number(),
      heapTotal: t.Number(),
    }),
    config: t.Object({
      files: t.Number(),
      selected: t.String(),
      providers: ProviderCountsSchema,
    }),
    lastRun: LastRunSchema,
    kiroBlacklistSize: t.Number(),
    activeRuns: t.Array(t.String()),
  }),
});

interface RawRun {
  timestamp?: string;
  results?: { http?: { pass?: boolean } }[];
}

/**
 * Read the newest `logs/*-model-tests.json` and return a compact summary.
 * Lexicographic sort on the ISO-ish filename prefix picks the latest run.
 */
function summarizeLastRun() {
  if (!existsSync(LOGS_DIR)) return null;
  let newestId: string | null = null;
  for (const file of readdirSync(LOGS_DIR)) {
    const match = TEST_FILE_RE.exec(file);
    if (!match) continue;
    const id = match[1]!;
    if (!newestId || id > newestId) newestId = id;
  }
  if (!newestId) return null;
  const path = join(LOGS_DIR, `${newestId}-model-tests.json`);
  try {
    const run = JSON.parse(readFileSync(path, "utf8")) as RawRun;
    const results = run.results ?? [];
    const passed = results.filter((r) => r.http?.pass === true).length;
    return {
      id: newestId,
      timestamp: run.timestamp ?? newestId,
      total: results.length,
      passed,
      failed: results.length - passed,
    };
  } catch {
    return null;
  }
}

function kiroBlacklistCount(): number {
  const path = join(LOGS_DIR, KIRO_FILE);
  if (!existsSync(path)) return 0;
  try {
    const map = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    return Object.keys(map).length;
  } catch {
    return 0;
  }
}

/**
 * Count providers by variant in the currently-selected config, so the
 * health card can double as a config sanity check. Falls back to zeros
 * if the config can't be parsed.
 */
async function configSummary() {
  const files = listConfigs();
  const path = configPath("");
  const counts = { newapi: 0, sub2api: 0, direct: 0, nvidia: 0, total: 0 };
  try {
    const config = applyOnlyProviders(await loadConfig(path), []);
    for (const provider of config.providers) {
      counts[provider.type]++;
      counts.total++;
    }
  } catch {
    // leave counts at zero
  }
  // Use mtime of logs dir to surface "selected" — client owns the actually
  // selected name via ui-store; health just reports what the server sees as
  // the main fallback path here.
  return { files: files.length, selected: path, providers: counts };
}

export const healthRoute = new Elysia({ prefix: "/health" }).get(
  "/",
  async () => {
    const up = process.uptime();
    const mem = process.memoryUsage();
    return {
      success: true as const,
      data: {
        ok: true,
        version: pkg.version,
        uptime: up,
        startedAt: new Date(Date.now() - up * 1000).toISOString(),
        runtime: {
          bun: Bun.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
        },
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
        config: await configSummary(),
        lastRun: summarizeLastRun(),
        kiroBlacklistSize: kiroBlacklistCount(),
        activeRuns: listActiveRuns(),
      },
    };
  },
  { response: ResponseSchema },
);
