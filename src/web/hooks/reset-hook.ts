import { rpc } from "@web/lib/rpc";
import { handleElysia } from "@shared/base";
import { useSyncStore } from "@web/store/sync-store";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

export function useResetPipeline() {
  const store = useSyncStore();

  return useMutation({
    mutationFn: async (args: { only?: string[] }) => {
      store.start("reset");
      store.addLog("info", "reset started");
      const result = handleElysia(
        await rpc.api.reset.post({ only: args.only ?? [] }),
      );
      store.addLog(
        "info",
        `channels=-${result.channelsDeleted} models=-${result.modelsDeleted} orphans=-${result.orphanModelsDeleted} tokens=-${result.tokensDeleted}`,
      );
      store.finish(result);
      return result;
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      store.fail(message);
      toast.error(message);
    },
  });
}
