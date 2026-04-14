import { useTranslations } from "use-intl";
import { rpc } from "@web/lib/rpc";
import { useSyncStore } from "@web/store/sync-store";
import { useUiStore } from "@web/store/ui-store";
import type { SyncMode } from "@web/types";
import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";

interface RunArgs {
  mode: SyncMode;
  only?: string[];
}

/**
 * `stop()` aborts the server-side task via `/pipeline/cancel` but leaves the
 * SSE stream open so final cleanup frames (summary, report-written) still
 * reach the UI — that's why it's a separate POST rather than closing the
 * stream.
 */
export function useSyncPipeline() {
  const store = useSyncStore();
  const t = useTranslations();
  const selectedConfigName = useUiStore((s) => s.selectedConfigName);
  const runIdRef = useRef<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (args: RunArgs) => {
      store.start(args.mode);
      runIdRef.current = null;

      const payload = { only: args.only ?? [], configName: selectedConfigName };

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
          if (frame.kind === "run") {
            runIdRef.current = frame.id;
          } else if (frame.kind === "start") {
            store.addLog("info", t("SYNC.PIPELINE_STARTED"));
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
      store.fail(t("SYNC.STOPPED_NO_CONNECTION"));
      return;
    }
    store.addLog("warn", t("SYNC.STOP_REQUESTED"));
    try {
      await rpc.api.pipeline.cancel.post({ id });
    } catch (error) {
      // If the cancel call fails we still want the UI to reflect intent;
      // the server-side pipeline will run to completion but that's a network
      // fault the user can retry.
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t("SYNC.CANCEL_FAILED", { message }));
    }
  };

  return { ...mutation, stop };
}
