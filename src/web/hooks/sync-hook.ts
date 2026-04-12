import { streamSse } from "@web/lib/sse-client";
import { useSyncStore, type SyncMode } from "@web/store/sync-store";
import { useUiStore } from "@web/store/ui-store";
import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";

interface RunArgs {
  mode: SyncMode;
  only?: string[];
}

/**
 * Kick off a sync pipeline (run / test / reset) via SSE, streaming logs and
 * the terminal result into the Zustand store. Returns the mutation plus a
 * `stop()` that aborts the in-flight SSE connection — the server propagates
 * that abort into the pipeline so work actually halts.
 */
export function useSyncPipeline() {
  const store = useSyncStore();
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation({
    mutationFn: async (args: RunArgs) => {
      store.start(args.mode);

      const configName = useUiStore.getState().selectedConfigName;
      const url =
        args.mode === "run"
          ? "/api/run"
          : args.mode === "test"
            ? "/api/test"
            : "/api/reset";

      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        await streamSse(
          url,
          { only: args.only ?? [], configName },
          (evt) => {
            if (evt.event === "log") {
              try {
                const parsed = JSON.parse(evt.data) as {
                  level: string;
                  message: string;
                };
                store.addLog(parsed.level, parsed.message);
              } catch {
                store.addLog("info", evt.data);
              }
            } else if (evt.event === "done") {
              try {
                store.finish(JSON.parse(evt.data));
              } catch {
                store.finish(evt.data);
              }
            } else if (evt.event === "error") {
              try {
                const parsed = JSON.parse(evt.data) as { message?: string };
                store.fail(parsed.message ?? "Unknown error");
              } catch {
                store.fail(evt.data);
              }
            } else if (evt.event === "start") {
              store.addLog("info", "pipeline started");
            }
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          // Expected when the user clicked Stop; store.fail already ran via
          // the "error" event, or will after the server emits it.
          return;
        }
        throw error;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      store.fail(message);
      toast.error(message);
    },
  });

  const stop = () => {
    const controller = controllerRef.current;
    if (controller) {
      controller.abort();
      store.addLog("warn", "stop requested");
      return;
    }
    // Orphaned `running` state (page refresh after server restart, etc).
    // Nothing to abort — just clear the stuck phase so the UI is usable.
    store.fail("stopped (no active connection)");
  };

  return { ...mutation, stop };
}
