import { consola } from "consola";
import type { ConsolaReporter } from "consola";
import { sse } from "elysia";

/**
 * Per-process registry of in-flight pipeline runs so an explicit `/cancel`
 * request can abort one by id without tearing down its SSE stream. That lets
 * the server finish its cleanup phase (writing reports, printing summaries)
 * and flush those final log events to the still-connected client.
 *
 * Keyed by run id; each entry holds the AbortController whose signal is fed
 * into the run via AsyncLocalStorage (see `@core/abort`).
 */
const activeRuns = new Map<string, AbortController>();

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

/**
 * Discriminated union of every frame a pipeline stream can yield. Elysia
 * serialises each yielded value as an SSE `data:` payload, and Eden Treaty
 * exposes the stream on the client as `AsyncIterable<PipelineFrame>` — no
 * manual `JSON.parse` or event-name dispatch required.
 */
export type PipelineFrame =
  | { kind: "run"; id: string }
  | { kind: "start"; at: string }
  | { kind: "log"; level: string; message: string }
  | { kind: "done"; result: unknown }
  | { kind: "error"; message: string };

export type PipelineEmitter = (frame: Extract<PipelineFrame, { kind: "start" }>) => void;

/**
 * Wrap a long-running pipeline task as an async generator that yields typed
 * SSE frames. Elysia detects the generator return and streams each yielded
 * value as a `text/event-stream` `data:` chunk.
 *
 * While the task runs, a consola reporter captures log lines and pushes them
 * into an internal queue which the generator drains between task-completion
 * checks. The task's own `emit()` helper feeds non-log frames (e.g. `start`)
 * into the same queue. When the task resolves we yield `done`; on rejection
 * we yield `error`. Either way the `run` frame is emitted first so the client
 * can capture the id for `/pipeline/cancel`.
 */
export async function* pipelineStream(
  task: (emit: PipelineEmitter, signal: AbortSignal) => Promise<unknown>,
  request?: { signal?: AbortSignal },
): AsyncGenerator<{ readonly data: PipelineFrame }> {
  const controller = new AbortController();
  const runId = Bun.randomUUIDv7();
  activeRuns.set(runId, controller);

  // Forward request-level aborts (client disconnect) into the task signal.
  const upstream = request?.signal;
  const onUpstreamAbort = () => controller.abort();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  // Bounded async queue bridging the push-based consola reporter to the
  // pull-based generator. `waiter` is resolved whenever new frames arrive so
  // the generator can `await` it without busy-looping.
  const queue: PipelineFrame[] = [];
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
        .map((part) =>
          typeof part === "string" ? part : JSON.stringify(part),
        )
        .join(" ");
      push({ kind: "log", level: logObj.type, message });
    },
  };

  consola.addReporter(reporter);

  // Kick off the task; its settlement triggers a final wake so the generator
  // drains any pending log frames and then yields the terminal frame.
  let settled = false;
  let terminal: PipelineFrame;
  const taskPromise = task(
    (frame) => push(frame),
    controller.signal,
  )
    .then((result): void => {
      terminal = { kind: "done", result: result ?? null };
    })
    .catch((error: unknown): void => {
      const aborted =
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError");
      terminal = {
        kind: "error",
        message: aborted
          ? "cancelled by user"
          : error instanceof Error
            ? error.message
            : String(error),
      };
    })
    .finally(() => {
      settled = true;
      wake();
    });

  // Announce the run id before anything else so the client can wire Stop.
  yield sse({ data: { kind: "run", id: runId } as PipelineFrame });

  try {
    while (true) {
      while (queue.length > 0) {
        yield sse({ data: queue.shift()! });
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
    // Drain any frames pushed between the last shift and the settle signal.
    while (queue.length > 0) {
      yield sse({ data: queue.shift()! });
    }
    // `terminal` is always assigned once `settled` is true.
    yield sse({ data: terminal! });
  } finally {
    consola.removeReporter(reporter);
    activeRuns.delete(runId);
    if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
    // If the client disconnected mid-stream, propagate to the task so
    // downstream work (HTTP requests, DB writes) stops promptly.
    if (!settled) controller.abort();
    await taskPromise;
  }
}
