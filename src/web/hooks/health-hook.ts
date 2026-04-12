import { rpc } from "@web/lib/rpc";
import { queryKeys } from "@web/lib/react-query/keys";
import { useQuery } from "@tanstack/react-query";

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: async () => {
      const res = await rpc.api.health.get();
      if (res.error) throw res.error;
      return res.data.data;
    },
    // Poll every 5s so uptime/memory/active-runs stay fresh without a refresh.
    refetchInterval: 5000,
  });
}
