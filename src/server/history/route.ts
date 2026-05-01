import {
  AuthenticityDeleteResponsesSchema,
  AuthenticityKeyParamsSchema,
  AuthenticityListResponseSchema,
  RunDetailResponsesSchema,
  RunIdParamsSchema,
  RunsListResponseSchema,
} from "@core/validations/history";
import { t } from "@server/i18n";
import { Elysia } from "elysia";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * History routes — exposes the `logs/` directory.
 *
 * Log files:
 *   - `<iso>-model-tests.json`        — one per sync run; written by
 *                                       `core/testing/runner.ts:writeTestReport`.
 *                                       Top-level shape: `{ timestamp, providers,
 *                                       summary?, modelTests, pricingGate?,
 *                                       openrouterEndpoints? }`. Old reports
 *                                       used `results` instead of `modelTests`;
 *                                       the route accepts both.
 *   - `authenticity-blacklist.json`   — persistent map of
 *                                       "<provider>/<group>|<model>" → { since, reason }
 */

const LOGS_DIR = "logs";
const TEST_FILE_RE = /^(.+)-model-tests\.json$/;
const AUTHENTICITY_FILE = "authenticity-blacklist.json";

interface RawResult {
  provider: string;
  model: string;
  http: { pass: boolean };
}
interface RawRun {
  timestamp?: string;
  /** Current field name (since the 2026-04-30 testing refactor). */
  modelTests?: RawResult[];
  /** Legacy field name. Kept so historical reports stay readable. */
  results?: RawResult[];
  /** Pass-through fields surfaced by the run-detail endpoint. */
  summary?: unknown;
  providers?: unknown;
  pricingGate?: unknown;
  openrouterEndpoints?: unknown;
}

function runResults(run: RawRun): RawResult[] {
  return run.modelTests ?? run.results ?? [];
}

function listRunIds(): string[] {
  if (!existsSync(LOGS_DIR)) return [];
  const ids: string[] = [];
  for (const file of readdirSync(LOGS_DIR)) {
    const match = TEST_FILE_RE.exec(file);
    if (match) ids.push(match[1]!);
  }
  // Newest first. Lexicographic sort on the ISO-ish id works because the
  // filename prefix is `YYYY-MM-DDTHH-MM-SS-sss-Z`.
  ids.sort((a, b) => b.localeCompare(a));
  return ids;
}

function runPath(id: string): string {
  return join(LOGS_DIR, `${id}-model-tests.json`);
}

function readRun(id: string): RawRun | null {
  const path = runPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawRun;
  } catch {
    return null;
  }
}

function summarize(id: string): {
  id: string;
  timestamp: string;
  size: number;
  total: number;
  passed: number;
  failed: number;
} | null {
  const path = runPath(id);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  const run = readRun(id);
  if (!run) return null;
  const results = runResults(run);
  const passed = results.filter((r) => r.http?.pass === true).length;
  return {
    id,
    timestamp: run.timestamp ?? id,
    size: stat.size,
    total: results.length,
    passed,
    failed: results.length - passed,
  };
}

function authenticityPath(): string {
  return join(LOGS_DIR, AUTHENTICITY_FILE);
}

type AuthenticityMap = Record<string, { since: string; reason: string }>;

function readAuthenticity(): AuthenticityMap {
  const path = authenticityPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AuthenticityMap;
  } catch {
    return {};
  }
}

function writeAuthenticity(map: AuthenticityMap): void {
  writeFileSync(authenticityPath(), JSON.stringify(map, null, 2));
}

/** Split "<provider>/<group>|<model>" into its parts. */
function splitAuthenticityKey(key: string): {
  provider: string;
  group: string;
  model: string;
} {
  const pipeIdx = key.indexOf("|");
  const left = pipeIdx === -1 ? key : key.slice(0, pipeIdx);
  const model = pipeIdx === -1 ? "" : key.slice(pipeIdx + 1);
  const slashIdx = left.indexOf("/");
  const provider = slashIdx === -1 ? left : left.slice(0, slashIdx);
  const group = slashIdx === -1 ? "" : left.slice(slashIdx + 1);
  return { provider, group, model };
}

export const historyRoute = new Elysia({ prefix: "/history" })
  .get(
    "/runs",
    () => {
      const runs = listRunIds()
        .map(summarize)
        .filter(
          (r): r is NonNullable<ReturnType<typeof summarize>> => r !== null,
        );
      return { success: true as const, data: runs };
    },
    { response: RunsListResponseSchema },
  )
  .get(
    "/runs/:id",
    async ({ params, set }) => {
      const run = readRun(params.id);
      if (!run) {
        set.status = 404;
        return { success: false as const, message: t("SERVER.RUN_NOT_FOUND") };
      }
      return {
        success: true as const,
        data: {
          id: params.id,
          timestamp: run.timestamp ?? params.id,
          results: runResults(run) as never,
          summary: run.summary as never,
          providers: run.providers as never,
          pricingGate: run.pricingGate as never,
          openrouterEndpoints: run.openrouterEndpoints as never,
        },
      };
    },
    {
      params: RunIdParamsSchema,
      response: RunDetailResponsesSchema,
    },
  )
  .get(
    "/authenticity",
    () => {
      const map = readAuthenticity();
      const entries = Object.entries(map)
        .map(([key, value]) => {
          const split = splitAuthenticityKey(key);
          return { key, ...split, since: value.since, reason: value.reason };
        })
        .sort((a, b) => b.since.localeCompare(a.since));
      return { success: true as const, data: entries };
    },
    { response: AuthenticityListResponseSchema },
  )
  .delete(
    "/authenticity/:key",
    async ({ params, set }) => {
      const map = readAuthenticity();
      if (!(params.key in map)) {
        set.status = 404;
        return {
          success: false as const,
          message: t("SERVER.ENTRY_NOT_FOUND"),
        };
      }
      delete map[params.key];
      writeAuthenticity(map);
      return { success: true as const, data: { deleted: params.key } };
    },
    {
      params: AuthenticityKeyParamsSchema,
      response: AuthenticityDeleteResponsesSchema,
    },
  );
