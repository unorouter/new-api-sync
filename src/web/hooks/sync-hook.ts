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
 * `stop()` that POSTs to `/api/pipeline/cancel` with the active run id —
 * aborts the pipeline while keeping the SSE stream open, so the final
 * cleanup logs (summary, report-written) still reach the UI.
 */
export function useSyncPipeline() {
  const store = useSyncStore();
  const runIdRef = useRef<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (args: RunArgs) => {
      store.start(args.mode);
      runIdRef.current = null;

      const configName = useUiStore.getState().selectedConfigName;
      const url =
        args.mode === "run"
          ? "/api/pipeline/run"
          : args.mode === "test"
            ? "/api/pipeline/test"
            : "/api/pipeline/reset";

      try {
        await streamSse(url, { only: args.only ?? [], configName }, (evt) => {
          if (evt.event === "run") {
            try {
              const parsed = JSON.parse(evt.data) as { id?: string };
              if (parsed.id) runIdRef.current = parsed.id;
            } catch {
              // ignore malformed id frame
            }
          } else if (evt.event === "log") {
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
        });
      } finally {
        runIdRef.current = null;
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      store.fail(message);
      toast.error(message);
    },
  });

  const stop = async () => {
    const id = runIdRef.current;
    if (!id) {
      // Orphaned `running` state (page refresh, server restart). Nothing to
      // cancel on the server — just clear the stuck phase locally.
      store.fail("stopped (no active connection)");
      return;
    }
    store.addLog("warn", "stop requested");
    try {
      await fetch("/api/pipeline/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch (error) {
      // If the cancel POST fails we still want the UI to reflect intent;
      // the server-side pipeline will run to completion but that's a network
      // fault the user can retry.
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`cancel failed: ${message}`);
    }
  };

  return { ...mutation, stop };
}
