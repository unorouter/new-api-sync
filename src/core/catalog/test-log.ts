import { consola } from "consola";

interface StageOutcome {
  pass: boolean;
  status?: number | null;
  latencyMs?: number;
  error?: string | null;
  body?: unknown;
}

interface TestSummary {
  prefix: string;
  model: string;
  http: StageOutcome;
  stream?: StageOutcome | null;
  tool?: StageOutcome | null;
  modelType?: string;
}

function snippet(value: unknown, max = 200): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function mark(stage: StageOutcome | null | undefined): string {
  if (stage === null || stage === undefined) return "·";
  return stage.pass ? "✓" : "✗";
}

function firstFailure(summary: TestSummary): StageOutcome | null {
  const stages: Array<[string, StageOutcome | null | undefined]> = [
    ["HTTP", summary.http],
    ["Stream", summary.stream],
    ["Tool", summary.tool],
  ];
  for (const [, stage] of stages) {
    if (stage && !stage.pass) return stage;
  }
  return null;
}

function totalLatency(summary: TestSummary): number {
  return (
    (summary.http.latencyMs ?? 0) +
    (summary.stream?.latencyMs ?? 0) +
    (summary.tool?.latencyMs ?? 0)
  );
}

export function logTestSummary(summary: TestSummary): void {
  const h = mark(summary.http);
  const s =
    summary.stream === undefined ? "" : ` ${mark(summary.stream)}Stream`;
  const t = summary.tool === undefined ? "" : ` ${mark(summary.tool)}Tool`;
  const type = summary.modelType ? ` | type=${summary.modelType}` : "";
  const ms = totalLatency(summary);
  const fail = firstFailure(summary);

  const base = `[${summary.prefix}] ${summary.model}: ${h}HTTP${s}${t}${type} ${ms}ms`;

  if (!fail) {
    consola.info(base);
    return;
  }

  const status = fail.status ?? "-";
  const body = snippet(fail.body ?? "");
  consola.warn(
    `${base} status=${status} err=${fail.error ?? "-"}${body ? ` body=${body}` : ""}`,
  );
}
