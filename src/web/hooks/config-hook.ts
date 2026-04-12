import { rpc } from "@web/lib/rpc";
import { queryKeys } from "@web/lib/react-query/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config(),
    queryFn: async () => {
      const res = await rpc.api.config.get();
      if (res.error) throw res.error;
      return res.data.data;
    },
  });
}

export function useSaveConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (yaml: string) => {
      const res = await rpc.api.config.put({ yaml });
      if (res.error) {
        const value = res.error.value;
        throw new Error(
          value && typeof value === "object" && "message" in value
            ? String(value.message)
            : "Failed to save config",
        );
      }
      return res.data.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.config(), data);
      toast.success("Config saved");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
