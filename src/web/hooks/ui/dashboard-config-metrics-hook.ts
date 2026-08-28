import type { ConfigSchemaType } from "@core/validations/config";
import { useConfig } from "@web/hooks/config-hook";

export type ConfigMetrics = {
  blacklistCount: number;
  modelMappingCount: number;
  providersWithOverrides: number;
  providerBreakdown: Record<string, number> | null;
};

function getConfigMetrics(
  configData: ConfigSchemaType | undefined,
): ConfigMetrics {
  const blacklistCount = configData?.blacklist?.length ?? 0;
  const modelMappingCount = configData
    ? Object.keys(configData.modelMapping ?? {}).length
    : 0;
  const providerBreakdown = configData
    ? configData.providers.reduce<Record<string, number>>(
        (counts, provider) => {
          counts.total = (counts.total ?? 0) + 1;
          counts[provider.type] = (counts[provider.type] ?? 0) + 1;
          return counts;
        },
        { total: 0 },
      )
    : null;
  const providersWithOverrides = configData
    ? configData.providers.filter((provider) => {
        return (
          ("testModelTypes" in provider &&
            provider.testModelTypes !== undefined) ||
          ("enabledModels" in provider &&
            provider.enabledModels !== undefined) ||
          ("priceAdjustment" in provider &&
            provider.priceAdjustment !== undefined)
        );
      }).length
    : 0;

  return {
    blacklistCount,
    modelMappingCount,
    providersWithOverrides,
    providerBreakdown,
  };
}

export function useDashboardConfigMetrics(selectedConfigName: string) {
  const selectedConfig = useConfig(selectedConfigName);
  const metrics = getConfigMetrics(selectedConfig.data?.config);

  return {
    selectedConfig,
    metrics,
  };
}
