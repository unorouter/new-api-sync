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
export const PROBE_IDS_OBJECT = "reconcile/probe-ids.jsonl";
const RETENTION_SECONDS = 7 * 24 * 3600;
const HEADER = "x-oneapi-request-id";

interface ProbeIdLine {
  id: string;
  at: number;
  label: string;
}

const pending: string[] = [];
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
): void {
  const id = idFrom(headers);
  if (!id) return;
  const line: ProbeIdLine = {
    id,
    at: Math.floor(Date.now() / 1000),
    label,
  };
  const text = JSON.stringify(line);
  mkdirSync(logsDir(), { recursive: true });
  appendFileSync(localPath(), text + "\n");
  pending.push(text);
}

export async function flushProbeIds(store: VerdictStore | null): Promise<void> {
  if (!store || pending.length === 0) return;
  const lines = pending.splice(0);
  try {
    await store.appendText(PROBE_IDS_OBJECT, lines, "application/x-ndjson");
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
      const remote = await store.readText(PROBE_IDS_OBJECT);
      if (remote) parseLines(remote, cutoff, ids);
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
