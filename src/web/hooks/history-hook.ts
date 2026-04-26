import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { queryKeys } from "@web/lib/react-query/keys";
import { rpc } from "@web/lib/rpc";
import { toast } from "sonner";

export function useHistoryRuns() {
  return useQuery({
    queryKey: queryKeys.historyRuns(),
    queryFn: async () => {
      const res = await rpc.api.history.runs.get();
      if (res.error) throw res.error;
      return res.data.data;
    },
  });
}

export function useHistoryRun(id: string | null) {
  return useQuery({
    queryKey: queryKeys.historyRun(id ?? ""),
    queryFn: async () => {
      if (!id) throw new Error("id required");
      const res = await rpc.api.history.runs({ id }).get();
      if (res.error) throw res.error;
      return res.data.data;
    },
    enabled: !!id,
  });
}

export function useAuthenticityBlacklist() {
  return useQuery({
    queryKey: queryKeys.historyAuthenticity(),
    queryFn: async () => {
      const res = await rpc.api.history.authenticity.get();
      if (res.error) throw res.error;
      return res.data.data;
    },
  });
}

export function useDeleteAuthenticityEntry() {
  const queryClient = useQueryClient();
  const t = useTranslations();
  return useMutation({
    mutationFn: async (key: string) => {
      const res = await rpc.api.history.authenticity({ key }).delete();
      if (res.error) throw res.error;
      return res.data.data;
    },
    onSuccess: (_, key) => {
      queryClient.setQueryData(
        queryKeys.historyAuthenticity(),
        (prev: { key: string }[] | undefined) =>
          prev?.filter((entry) => entry.key !== key) ?? [],
      );
      toast.success(t("TOAST.AUTHENTICITY_REMOVED"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
