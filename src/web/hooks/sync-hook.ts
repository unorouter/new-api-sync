import { streamSse } from "@ui/lib/sse-client";
import { useSyncStore, type SyncMode } from "@ui/store/sync-store";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

interface RunArgs {
  mode: SyncMode;
  only?: string[];
}

/**
 * Kick off a sync pipeline (run / test) via SSE, streaming logs and the
 * terminal result into the Zustand store.
 */
export function useSyncPipeline() {
  const store = useSyncStore();

  return useMutation({
    mutationFn: async (args: RunArgs) => {
      store.start(args.mode);

      const url = args.mode === "run" ? "/api/run" : "/api/test";
      await streamSse(url, { only: args.only ?? [] }, (evt) => {
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
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      store.fail(message);
      toast.error(message);
    },
  });
}
