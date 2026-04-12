import { rpc } from "@web/lib/rpc";
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
 * Kick off a sync pipeline (run / test / reset) via Eden's streamed generator
 * route, draining typed frames into the Zustand store. Returns the mutation
 * plus a `stop()` that calls `/api/pipeline/cancel` with the active run id —
 * aborts the pipeline while keeping the stream open, so the final cleanup
 * frames (summary, report-written) still reach the UI.
 */
export function useSyncPipeline() {
  const store = useSyncStore();
  const runIdRef = useRef<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (args: RunArgs) => {
      store.start(args.mode);
      runIdRef.current = null;

      const configName = useUiStore.getState().selectedConfigName;
      const payload = { only: args.only ?? [], configName };

      const call =
        args.mode === "run"
          ? rpc.api.pipeline.run.post(payload)
          : args.mode === "test"
            ? rpc.api.pipeline.test.post(payload)
            : rpc.api.pipeline.reset.post(payload);

      try {
        const res = await call;
        if (res.error) throw new Error(String(res.error.value));

        for await (const envelope of res.data) {
          const frame = envelope.data;
          if (!frame) continue;
          if (frame.kind === "run") {
            runIdRef.current = frame.id;
          } else if (frame.kind === "start") {
            store.addLog("info", "pipeline started");
          } else if (frame.kind === "log") {
            store.addLog(frame.level, frame.message);
          } else if (frame.kind === "done") {
            store.finish(frame.result);
          } else if (frame.kind === "error") {
            store.fail(frame.message);
          }
        }
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
      await rpc.api.pipeline.cancel.post({ id });
    } catch (error) {
      // If the cancel call fails we still want the UI to reflect intent;
      // the server-side pipeline will run to completion but that's a network
      // fault the user can retry.
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`cancel failed: ${message}`);
    }
  };

  return { ...mutation, stop };
}
