import { applyOnlyProviders, loadConfig } from "@core/config";
import { HealthResponseSchema } from "@core/validations/health";
import { configPath, listConfigs } from "@server/config/route";
import { listActiveRuns } from "@server/sse";
import { Elysia } from "elysia";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };

const LOGS_DIR = "logs";
const TEST_FILE_RE = /^(.+)-model-tests\.json$/;
const AUTHENTICITY_FILE = "authenticity-cache.json";
const LEGACY_AUTHENTICITY_FILE = "authenticity-blacklist.json";

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

// Count blacklisted (verdict "fail") entries only; "pass" entries are trusted
// channels, not failures. Falls back to the legacy fail-only map.
function authenticityBlacklistCount(): number {
  const path = join(LOGS_DIR, AUTHENTICITY_FILE);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(raw))
        return raw.filter(
          (e) => (e as { verdict?: string })?.verdict !== "pass",
        ).length;
    } catch {
      return 0;
    }
  }
  const legacy = join(LOGS_DIR, LEGACY_AUTHENTICITY_FILE);
  if (!existsSync(legacy)) return 0;
  try {
    const raw = JSON.parse(readFileSync(legacy, "utf8")) as Record<
      string,
      unknown
    >;
    const map = "entries" in raw ? (raw.entries as object) : raw;
    return Object.keys(map ?? {}).length;
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
  const counts: Record<string, number> = { total: 0 };
  try {
    const config = applyOnlyProviders(await loadConfig(path), []);
    for (const provider of config.providers) {
      counts[provider.type] = (counts[provider.type] ?? 0) + 1;
      counts.total = (counts.total ?? 0) + 1;
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
        authenticityBlacklistSize: authenticityBlacklistCount(),
        activeRuns: listActiveRuns(),
      },
    };
  },
  { response: HealthResponseSchema },
);
