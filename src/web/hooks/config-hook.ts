import type { ConfigSchemaType } from "@core/config";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@web/lib/react-query/keys";
import { rpc } from "@web/lib/rpc";
import { toast } from "sonner";

/** Fetch one config by name. Empty string = main `config.yml`. */
export function useConfig(name: string) {
  return useQuery({
    queryKey: [...queryKeys.config(), name],
    queryFn: async () => {
      const res = await rpc.api.config.get({ query: { name } });
      if (res.error) throw res.error;
      return res.data.data;
    },
  });
}

export function useSaveConfig(name: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: ConfigSchemaType) => {
      const res = await rpc.api.config.put({ config }, { query: { name } });
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
      queryClient.setQueryData([...queryKeys.config(), name], data);
      toast.success("Config saved");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}

/** List every config file in the project root (main + named variants). */
export function useConfigFiles() {
  return useQuery({
    queryKey: queryKeys.configFiles(),
    queryFn: async () => {
      const res = await rpc.api.config.files.get();
      if (res.error) throw res.error;
      return res.data.data;
    },
  });
}

export function useCreateConfigFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; fromName?: string }) => {
      const res = await rpc.api.config.files.post(input);
      if (res.error) {
        const value = res.error.value;
        throw new Error(
          value && typeof value === "object" && "message" in value
            ? String(value.message)
            : "Failed to create config",
        );
      }
      return res.data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles() });
      toast.success("Config created");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}

export function useDeleteConfigFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await rpc.api.config.files({ name }).delete();
      if (res.error) throw res.error;
      return res.data.data;
    },
    onSuccess: (_, name) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles() });
      queryClient.removeQueries({ queryKey: [...queryKeys.config(), name] });
      toast.success("Config deleted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
