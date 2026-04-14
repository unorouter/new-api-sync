import type {
  GlobalConfigType,
  LocaleValue,
  ThemeValue,
} from "@core/validations/config";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntl } from "@web/components/provider/intl-provider";
import { msg } from "@web/lib/constants";
import { queryKeys } from "@web/lib/react-query/keys";
import { rpc } from "@web/lib/rpc";
import { toast } from "sonner";

/** Fetch `config.global.yml` contents. Missing file resolves as `{}`. */
export function useGlobalConfig() {
  return useQuery({
    queryKey: queryKeys.globalConfig(),
    queryFn: async () => {
      const res = await rpc.api.config.global.get();
      if (res.error) throw res.error;
      return res.data.data.config;
    },
  });
}

/** Overwrite the whole global-config file. */
export function useSaveGlobalConfig() {
  const queryClient = useQueryClient();
  const { t } = useIntl();
  return useMutation({
    mutationFn: async (config: GlobalConfigType) => {
      const res = await rpc.api.config.global.put({ config });
      if (res.error) {
        const value = res.error.value;
        throw new Error(
          value && typeof value === "object" && "message" in value
            ? String(value.message)
            : t(msg("TOAST.GLOBAL_CONFIG_SAVE_FAILED")),
        );
      }
      return res.data.data.config;
    },
    onSuccess: (config) => {
      queryClient.setQueryData(queryKeys.globalConfig(), config);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}

/**
 * Read-modify-write the `locale` field on the global config. Keeps the
 * call-site ergonomic for a single toggle while still bouncing through
 * the React Query cache.
 */
export function useSetGlobalLocale() {
  const queryClient = useQueryClient();
  const save = useSaveGlobalConfig();
  return useMutation({
    mutationFn: async (locale: LocaleValue) => {
      const current =
        queryClient.getQueryData<GlobalConfigType>(queryKeys.globalConfig()) ??
        {};
      const next: GlobalConfigType = { ...current, locale };
      return save.mutateAsync(next);
    },
  });
}

/** Read-modify-write the `theme` field on the global config. */
export function useSetGlobalTheme() {
  const queryClient = useQueryClient();
  const save = useSaveGlobalConfig();
  return useMutation({
    mutationFn: async (theme: ThemeValue) => {
      const current =
        queryClient.getQueryData<GlobalConfigType>(queryKeys.globalConfig()) ??
        {};
      const next: GlobalConfigType = { ...current, theme };
      return save.mutateAsync(next);
    },
  });
}

/** Read-modify-write the selected config name on the global config. */
export function useSetGlobalSelectedConfig() {
  const queryClient = useQueryClient();
  const save = useSaveGlobalConfig();
  return useMutation({
    mutationFn: async (selectedConfigName: string) => {
      const current =
        queryClient.getQueryData<GlobalConfigType>(queryKeys.globalConfig()) ??
        {};
      const next: GlobalConfigType = { ...current, selectedConfigName };
      return save.mutateAsync(next);
    },
  });
}
