import type { ConfigSchemaType, LocaleValue } from "@core/validations/config";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntl } from "@web/components/provider/intl-provider";
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
  const { t } = useIntl();

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
      toast.success(t("TOAST.CONFIG_SAVED"));
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
  const { t } = useIntl();
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
      toast.success(t("TOAST.CONFIG_CREATED"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}

export function useDeleteConfigFile() {
  const queryClient = useQueryClient();
  const { t } = useIntl();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await rpc.api.config.files({ name }).delete();
      if (res.error) throw res.error;
      return res.data.data;
    },
    onSuccess: (_, name) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles() });
      queryClient.removeQueries({ queryKey: [...queryKeys.config(), name] });
      toast.success(t("TOAST.CONFIG_DELETED"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}

/** Fetch the UI locale from the given config (empty = main). */
export function useConfigLocale(name: string) {
  return useQuery({
    queryKey: [...queryKeys.configLocale(), name],
    queryFn: async () => {
      const res = await rpc.api.config.locale.get({ query: { name } });
      if (res.error) throw res.error;
      return res.data.data.locale;
    },
  });
}

export function useSetConfigLocale(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (locale: LocaleValue) => {
      const res = await rpc.api.config.locale.patch(
        { locale },
        { query: { name } },
      );
      if (res.error) {
        const value = res.error.value;
        throw new Error(
          value && typeof value === "object" && "message" in value
            ? String(value.message)
            : "Failed to update locale",
        );
      }
      return res.data.data.locale;
    },
    onSuccess: (locale) => {
      queryClient.setQueryData([...queryKeys.configLocale(), name], locale);
      // The full config also carries `locale`; invalidate so it's fresh next read.
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.config(), name],
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
