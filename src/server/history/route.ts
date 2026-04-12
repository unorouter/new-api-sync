import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Elysia, t } from "elysia";

/**
 * History routes — exposes the `logs/` directory.
 *
 * Log files:
 *   - `<iso>-model-tests.json` — one per test pipeline run; `{ timestamp, results[] }`
 *   - `kiro-blacklist.json`    — persistent map of
 *                                 "<provider>/<group>|<model>" → { since, reason }
 *
 * File formats come from `src/core/models/tester.ts`.
 */

const LOGS_DIR = "logs";
const TEST_FILE_RE = /^(.+)-model-tests\.json$/;
const KIRO_FILE = "kiro-blacklist.json";

const ResultHttpSchema = t.Object({
  pass: t.Boolean(),
  request: t.Object({ url: t.String(), body: t.Unknown() }),
  response: t.Unknown(),
  error: t.Optional(t.String()),
});

const ResultSchema = t.Object({
  provider: t.String(),
  model: t.String(),
  cost: t.Union([t.Number(), t.Null()]),
  http: ResultHttpSchema,
  stream: t.Union([ResultHttpSchema, t.Null()]),
  toolCall: t.Union([ResultHttpSchema, t.Null()]),
  authentic: t.Union([t.Boolean(), t.Null()]),
  kiroProbes: t.Optional(t.Array(t.Unknown())),
});

const RunSummarySchema = t.Object({
  id: t.String(),
  timestamp: t.String(),
  size: t.Number(),
  total: t.Number(),
  passed: t.Number(),
  failed: t.Number(),
});

const RunDetailSchema = t.Object({
  id: t.String(),
  timestamp: t.String(),
  results: t.Array(ResultSchema),
});

const KiroEntrySchema = t.Object({
  key: t.String(),
  provider: t.String(),
  group: t.String(),
  model: t.String(),
  since: t.String(),
  reason: t.String(),
});

interface RawResult {
  provider: string;
  model: string;
  http: { pass: boolean };
}
interface RawRun {
  timestamp?: string;
  results?: RawResult[];
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
  const results = run.results ?? [];
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

function kiroPath(): string {
  return join(LOGS_DIR, KIRO_FILE);
}

type KiroMap = Record<string, { since: string; reason: string }>;

function readKiro(): KiroMap {
  const path = kiroPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as KiroMap;
  } catch {
    return {};
  }
}

function writeKiro(map: KiroMap): void {
  writeFileSync(kiroPath(), JSON.stringify(map, null, 2));
}

/** Split "<provider>/<group>|<model>" into its parts. */
function splitKiroKey(key: string): {
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
    {
      response: t.Object({
        success: t.Literal(true),
        data: t.Array(RunSummarySchema),
      }),
    },
  )
  .get(
    "/runs/:id",
    ({ params, set }) => {
      const run = readRun(params.id);
      if (!run) {
        set.status = 404;
        return { success: false as const, message: "run not found" };
      }
      return {
        success: true as const,
        data: {
          id: params.id,
          timestamp: run.timestamp ?? params.id,
          results: (run.results ?? []) as never,
        },
      };
    },
    {
      params: t.Object({ id: t.String() }),
      response: {
        200: t.Object({ success: t.Literal(true), data: RunDetailSchema }),
        404: t.Object({ success: t.Literal(false), message: t.String() }),
      },
    },
  )
  .get(
    "/kiro",
    () => {
      const map = readKiro();
      const entries = Object.entries(map)
        .map(([key, value]) => {
          const split = splitKiroKey(key);
          return { key, ...split, since: value.since, reason: value.reason };
        })
        .sort((a, b) => b.since.localeCompare(a.since));
      return { success: true as const, data: entries };
    },
    {
      response: t.Object({
        success: t.Literal(true),
        data: t.Array(KiroEntrySchema),
      }),
    },
  )
  .delete(
    "/kiro/:key",
    ({ params, set }) => {
      const map = readKiro();
      if (!(params.key in map)) {
        set.status = 404;
        return { success: false as const, message: "entry not found" };
      }
      delete map[params.key];
      writeKiro(map);
      return { success: true as const, data: { deleted: params.key } };
    },
    {
      params: t.Object({ key: t.String() }),
      response: {
        200: t.Object({
          success: t.Literal(true),
          data: t.Object({ deleted: t.String() }),
        }),
        404: t.Object({ success: t.Literal(false), message: t.String() }),
      },
    },
  );
