import { rpc } from "@ui/lib/rpc";
import { queryKeys } from "@ui/lib/react-query/keys";
import { handleElysia } from "@shared/base";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config(),
    queryFn: async () => handleElysia(await rpc.api.config.get()),
  });
}

export function useSaveConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (yaml: string) =>
      handleElysia(await rpc.api.config.put({ yaml })),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.config(), data);
      toast.success("Config saved");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
