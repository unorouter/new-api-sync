import type { ConfigSchemaType } from "@core/validations/config";
import { useConfig } from "@web/hooks/config-hook";

export type ConfigMetrics = {
  blacklistCount: number;
  modelMappingCount: number;
  providersWithOverrides: number;
  providerBreakdown: {
    newapi: number;
    sub2api: number;
    direct: number;
    nvidia: number;
    openrouter: number;
    total: number;
  } | null;
};

function getConfigMetrics(configData: ConfigSchemaType | undefined): ConfigMetrics {
  const blacklistCount = configData?.blacklist?.length ?? 0;
  const modelMappingCount = configData
    ? Object.keys(configData.modelMapping ?? {}).length
    : 0;
  const providerBreakdown = configData
    ? configData.providers.reduce(
        (counts, provider) => {
          counts.total += 1;
          counts[provider.type] += 1;
          return counts;
        },
        { newapi: 0, sub2api: 0, direct: 0, nvidia: 0, openrouter: 0, total: 0 },
      )
    : null;
  const providersWithOverrides = configData
    ? configData.providers.filter((provider) => {
        return (
          provider.testModelTypes !== undefined ||
          provider.enabledVendors !== undefined ||
          provider.enabledModels !== undefined ||
          provider.priceAdjustment !== undefined
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
