import { rpc } from "@ui/lib/rpc";
import { queryKeys } from "@ui/lib/react-query/keys";
import { handleElysia } from "@shared/base";
import { useQuery } from "@tanstack/react-query";

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: async () => handleElysia(await rpc.api.health.get()),
  });
}
