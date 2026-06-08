import {
  AuthenticityDeleteResponsesSchema,
  AuthenticityKeyParamsSchema,
  AuthenticityListResponseSchema,
  RunDetailDataSchema,
  RunDetailResponsesSchema,
  RunIdParamsSchema,
  RunsListResponseSchema,
} from "@core/validations/history";
import { t } from "@server/i18n";
import { Value } from "@sinclair/typebox/value";
import { consola } from "consola";
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
 *   - `authenticity-cache.json`       — flat array of
 *                                       { key: "<provider>/<group>|<model>",
 *                                       verdict: "pass"|"fail", since, reason }.
 *                                       Reads the legacy `authenticity-blacklist.json`
 *                                       map (fail-only) as a fallback.
 */

const LOGS_DIR = "logs";
const TEST_FILE_RE = /^(.+)-model-tests\.json$/;
const AUTHENTICITY_FILE = "authenticity-cache.json";
const LEGACY_AUTHENTICITY_FILE = "authenticity-blacklist.json";

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

type Verdict = "pass" | "fail";
interface AuthenticityCacheEntry {
  key: string;
  verdict: Verdict;
  since: string;
  reason: string;
}
type LegacyEntry = { since: string; reason: string };
type LegacyBlacklist =
  | { entries: Record<string, LegacyEntry> }
  | Record<string, LegacyEntry>;

function readLegacyAuthenticity(): AuthenticityCacheEntry[] {
  const path = join(LOGS_DIR, LEGACY_AUTHENTICITY_FILE);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LegacyBlacklist;
    const entries =
      "entries" in raw && typeof raw.entries === "object"
        ? raw.entries
        : (raw as Record<string, LegacyEntry>);
    return Object.entries(entries)
      .filter(([, v]) => v && typeof v.since === "string")
      .map(([key, v]) => ({
        key,
        verdict: "fail" as const,
        since: v.since,
        reason: v.reason ?? "",
      }));
  } catch {
    return [];
  }
}

function readAuthenticity(): AuthenticityCacheEntry[] {
  const path = authenticityPath();
  if (!existsSync(path)) return readLegacyAuthenticity();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return readLegacyAuthenticity();
    return (raw as AuthenticityCacheEntry[])
      .filter((e) => e && typeof e.key === "string")
      .map((e) => ({
        key: e.key,
        verdict: e.verdict === "pass" ? "pass" : "fail",
        since: e.since ?? "",
        reason: e.reason ?? "",
      }));
  } catch {
    return readLegacyAuthenticity();
  }
}

function writeAuthenticity(entries: AuthenticityCacheEntry[]): void {
  writeFileSync(authenticityPath(), JSON.stringify(entries, null, 2));
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
      const data = {
        id: params.id,
        timestamp: run.timestamp ?? params.id,
        results: runResults(run),
        summary: run.summary,
        providers: run.providers,
        pricingGate: run.pricingGate,
        openrouterEndpoints: run.openrouterEndpoints,
      };
      // Disk JSON is untrusted: 422 on malformed instead of leaking bad shapes.
      if (!Value.Check(RunDetailDataSchema, data)) {
        const first = [...Value.Errors(RunDetailDataSchema, data)][0];
        consola.warn(
          `Malformed run log ${params.id}: ${first ? `${first.path} ${first.message}` : "schema mismatch"}`,
        );
        set.status = 422;
        return { success: false as const, message: t("SERVER.RUN_MALFORMED") };
      }
      return { success: true as const, data };
    },
    {
      params: RunIdParamsSchema,
      response: RunDetailResponsesSchema,
    },
  )
  .get(
    "/authenticity",
    () => {
      const entries = readAuthenticity()
        .map((entry) => ({
          key: entry.key,
          verdict: entry.verdict,
          ...splitAuthenticityKey(entry.key),
          since: entry.since,
          reason: entry.reason,
        }))
        .sort((a, b) => b.since.localeCompare(a.since));
      return { success: true as const, data: entries };
    },
    { response: AuthenticityListResponseSchema },
  )
  .delete(
    "/authenticity/:key",
    async ({ params, set }) => {
      const entries = readAuthenticity();
      if (!entries.some((e) => e.key === params.key)) {
        set.status = 404;
        return {
          success: false as const,
          message: t("SERVER.ENTRY_NOT_FOUND"),
        };
      }
      writeAuthenticity(entries.filter((e) => e.key !== params.key));
      return { success: true as const, data: { deleted: params.key } };
    },
    {
      params: AuthenticityKeyParamsSchema,
      response: AuthenticityDeleteResponsesSchema,
    },
  );
