import { consola } from "consola";
import type { ConsolaReporter } from "consola";

/**
 * Build an SSE ReadableStream around a long-running async task.
 *
 * While the task runs, a consola reporter is attached that forwards log entries
 * as `event: log` messages. The task can also push custom events via the
 * `emit()` helper passed to it. When the task resolves (or rejects) we send a
 * terminal `event: done` (or `event: error`) and close the stream.
 */
export type SseEmitter = (event: string, data: unknown) => void;

export function sseResponse(
  task: (emit: SseEmitter) => Promise<unknown>,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (event: string, data: unknown): void => {
        if (closed) return;
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${payload}\n\n`),
        );
      };

      const reporter: ConsolaReporter = {
        log: (logObj) => {
          // Skip debug by default; caller can adjust consola.level if needed.
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

      task(write)
        .then((result) => {
          write("done", result ?? null);
        })
        .catch((error: unknown) => {
          write("error", {
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          consola.removeReporter(reporter);
          closed = true;
          controller.close();
        });
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
