import { consola } from "consola";
import type { ConsolaReporter } from "consola";

/**
 * Build an SSE ReadableStream around a long-running async task.
 *
 * While the task runs, a consola reporter is attached that forwards log entries
 * as `event: log` messages. The task can also push custom events via the
 * `emit()` helper passed to it. When the task resolves (or rejects) we send a
 * terminal `event: done` (or `event: error`) and close the stream.
 *
 * The task receives an `AbortSignal` tied to the HTTP request: when the client
 * disconnects (e.g. user clicks Stop), the signal aborts so pipeline code can
 * bail out between phases. Tasks should periodically call
 * `signal.throwIfAborted()` inside their long loops.
 */
export type SseEmitter = (event: string, data: unknown) => void;

export function sseResponse(
  task: (emit: SseEmitter, signal: AbortSignal) => Promise<unknown>,
  request?: { signal?: AbortSignal },
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();

  // Shared flag so both `cancel()` (client disconnect) and the task's
  // `finally` branch agree on whether the stream is already dead. Without
  // this, the second close attempt throws ERR_INVALID_STATE and crashes Bun.
  let closed = false;

  // Forward request-level aborts (client disconnect) into the task signal.
  const upstream = request?.signal;
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else
      upstream.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          streamController.close();
        } catch {
          // Stream may already be torn down by cancel(); ignore.
        }
      };

      const write = (event: string, data: unknown): void => {
        if (closed) return;
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        try {
          streamController.enqueue(
            encoder.encode(`event: ${event}\ndata: ${payload}\n\n`),
          );
        } catch {
          // Client went away mid-write; treat as closed so we stop trying.
          closed = true;
        }
      };

      const reporter: ConsolaReporter = {
        log: (logObj) => {
          const message = [logObj.message, ...(logObj.args ?? [])]
            .filter((part) => part !== undefined)
            .map((part) =>
              typeof part === "string" ? part : JSON.stringify(part),
            )
            .join(" ");
          write("log", { level: logObj.type, message });
        },
      };

      consola.addReporter(reporter);

      task(write, controller.signal)
        .then((result) => {
          write("done", result ?? null);
        })
        .catch((error: unknown) => {
          const aborted =
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError");
          write("error", {
            message: aborted
              ? "cancelled by user"
              : error instanceof Error
                ? error.message
                : String(error),
          });
        })
        .finally(() => {
          consola.removeReporter(reporter);
          safeClose();
        });
    },
    cancel() {
      // Browser/client dropped the connection — propagate to the task.
      closed = true;
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
