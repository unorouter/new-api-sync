import { logsDir } from "@core/infra/paths";
import type { VerdictStore } from "@core/infra/verdict-store";
import { t } from "@server/i18n";
import { consola } from "consola";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// Every probe the sync sends to a relay is billed there without passing our
// gateway. The relay echoes its request id, so the id is recorded here and
// `sync reconcile` can account for those rows exactly.
const FILE = "probe-ids.jsonl";
const RETENTION_DAYS = 7;
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 3600;
// One object per UTC day, so a flush rewrites only today's lines.
const dayObject = (at: number) =>
  `reconcile/probe-ids/${new Date(at).toISOString().slice(0, 10)}.jsonl`;
// Pre-split object; drop after 2026-10-14 once its ids age out.
const LEGACY_OBJECT = "reconcile/probe-ids.jsonl";
const HEADER = "x-oneapi-request-id";

interface ProbeIdLine {
  id: string;
  at: number;
  label: string;
}

const pending: string[] = [];
const sentThisProcess: ProbeIdLine[] = [];
const localPath = () => join(logsDir(), FILE);

function idFrom(headers: Headers | Record<string, string>): string | null {
  if (headers instanceof Headers) return headers.get(HEADER);
  for (const [k, v] of Object.entries(headers))
    if (k.toLowerCase() === HEADER) return v;
  return null;
}

export function recordProbeRequestId(
  headers: Headers | Record<string, string>,
  label: string,
): string | null {
  const id = idFrom(headers);
  if (!id) return null;
  const line: ProbeIdLine = {
    id,
    at: Math.floor(Date.now() / 1000),
    label,
  };
  sentThisProcess.push(line);
  const text = JSON.stringify(line);
  mkdirSync(logsDir(), { recursive: true });
  appendFileSync(localPath(), text + "\n");
  pending.push(text);
  return id;
}

export function probeIdsSentSince(at: number): Set<string> {
  const ids = new Set<string>();
  for (const line of sentThisProcess) if (line.at >= at) ids.add(line.id);
  return ids;
}

export async function flushProbeIds(store: VerdictStore | null): Promise<void> {
  if (!store || pending.length === 0) return;
  const lines = pending.splice(0);
  try {
    await store.appendText(
      dayObject(Date.now()),
      lines,
      "application/x-ndjson",
    );
  } catch (err) {
    pending.unshift(...lines);
    consola.warn(
      t("CORE.PROBE_IDS.PUSH_FAILED", {
        store: store.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function parseLines(text: string, cutoff: number, into: Set<string>): void {
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === "object") {
        const p = v as Partial<ProbeIdLine>;
        if (typeof p.id === "string" && (p.at ?? 0) >= cutoff) into.add(p.id);
      }
    } catch {
      continue;
    }
  }
}

export async function loadProbeIds(
  store: VerdictStore | null,
): Promise<Set<string>> {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
  const ids = new Set<string>();
  if (existsSync(localPath()))
    parseLines(readFileSync(localPath(), "utf8"), cutoff, ids);
  if (store) {
    try {
      const objects = [LEGACY_OBJECT];
      for (let d = 0; d <= RETENTION_DAYS; d++)
        objects.push(dayObject(Date.now() - d * 86_400_000));
      for (const name of objects) {
        const remote = await store.readText(name);
        if (remote) parseLines(remote, cutoff, ids);
      }
    } catch (err) {
      consola.warn(
        t("CORE.PROBE_IDS.PULL_FAILED", {
          store: store.label,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return ids;
}
