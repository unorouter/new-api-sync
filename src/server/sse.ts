import { t } from "@server/i18n";
import type { ConsolaReporter } from "consola";
import { consola } from "consola";
import { sse } from "elysia";

/**
 * Per-process registry of in-flight pipeline runs so an explicit `/cancel`
 * request can abort one by id without tearing down its SSE stream. That lets
 * the server finish its cleanup phase (writing reports, printing summaries)
 * and flush those final log events to the still-connected client.
 */
const activeRuns = new Map<string, AbortController>();

/**
 * Refcount of streams that have requested verbose (debug-level) logging. While
 * this is > 0 consola runs at level 4. consola's level is a single global,
 * so concurrent verbose+non-verbose runs will both see debug output — that
 * noise is acceptable vs. the alternative of dropping debug frames entirely.
 */
let verboseRefCount = 0;
let savedConsolaLevel: number | null = null;
function acquireVerbose(): void {
  if (verboseRefCount === 0) {
    savedConsolaLevel = consola.level;
    consola.level = 4;
  }
  verboseRefCount++;
}
function releaseVerbose(): void {
  verboseRefCount--;
  if (verboseRefCount === 0 && savedConsolaLevel !== null) {
    consola.level = savedConsolaLevel;
    savedConsolaLevel = null;
  }
}

export function cancelActiveRun(id: string): boolean {
  const controller = activeRuns.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Surface which runs are currently in flight for the health card. */
export function listActiveRuns(): string[] {
  return [...activeRuns.keys()];
}

export type PipelineFrame =
  | { kind: "run"; id: string }
  | { kind: "start"; at: string }
  | { kind: "log"; level: string; message: string }
  | { kind: "done"; result: unknown }
  | { kind: "error"; message: string };

/**
 * Wrap a long-running pipeline task as an async generator that streams typed
 * SSE frames. A consola reporter forwards log lines into the same queue the
 * generator drains, so the client sees progress in real time. Cancel via
 * `/pipeline/cancel` aborts the task but leaves the stream open, which is
 * why the terminal `done`/`error` frame rides through the queue too.
 */
export async function* pipelineStream(
  task: (signal: AbortSignal) => Promise<unknown>,
  request?: { signal?: AbortSignal },
  opts?: { verbose?: boolean },
): AsyncGenerator<{ readonly data: PipelineFrame }> {
  const controller = new AbortController();
  const runId = Bun.randomUUIDv7();
  activeRuns.set(runId, controller);
  const verbose = !!opts?.verbose;
  if (verbose) acquireVerbose();

  const upstream = request?.signal;
  const onUpstreamAbort = () => controller.abort();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  // Push-based consola reporter, pull-based generator — bridge via a queue
  // plus a single-slot waiter so the generator parks instead of busy-looping.
  const queue: PipelineFrame[] = [];
  let done = false;
  let waiter: (() => void) | null = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  const push = (frame: PipelineFrame) => {
    queue.push(frame);
    wake();
  };

  const reporter: ConsolaReporter = {
    log: (logObj) => {
      const message = [logObj.message, ...(logObj.args ?? [])]
        .filter((part) => part !== undefined)
        .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
        .join(" ");
      push({ kind: "log", level: logObj.type, message });
    },
  };

  consola.addReporter(reporter);

  const taskPromise = task(controller.signal)
    .then((result) => {
      push({ kind: "done", result: result ?? null });
    })
    .catch((error: unknown) => {
      const aborted =
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError");
      const message = aborted
        ? t("ERROR.CANCELLED_BY_USER")
        : error instanceof Error
          ? error.message
          : String(error);
      push({ kind: "error", message });
    })
    .finally(() => {
      done = true;
      wake();
    });

  push({ kind: "run", id: runId });
  push({ kind: "start", at: new Date().toISOString() });

  try {
    while (true) {
      while (queue.length > 0) {
        yield sse({ data: queue.shift()! });
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
  } finally {
    consola.removeReporter(reporter);
    activeRuns.delete(runId);
    if (verbose) releaseVerbose();
    if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
    // Client disconnected mid-stream: propagate so in-flight HTTP/DB work stops.
    if (!done) controller.abort();
    await taskPromise;
  }
}
