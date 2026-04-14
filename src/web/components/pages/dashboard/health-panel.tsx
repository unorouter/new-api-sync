import type { ConfigSchemaType } from "@core/validations/config";
import { useIntl } from "@web/components/provider/intl-provider";
import { useConfig } from "@web/hooks/config-hook";
import { useHealth } from "@web/hooks/health-hook";
import { useUiStore } from "@web/store/ui-store";
import type { ConfigMetrics } from "./current-config-card";
import { CurrentConfigCard } from "./current-config-card";
import { ServerHealthCard } from "./server-health-card";

function getConfigMetrics(
  configData: ConfigSchemaType | undefined,
): ConfigMetrics {
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
        { newapi: 0, sub2api: 0, direct: 0, nvidia: 0, total: 0 },
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

export function HealthPanel() {
  const intl = useIntl();
  const health = useHealth();
  const selectedConfigName = useUiStore((state) => state.selectedConfigName);
  const selectedConfig = useConfig(selectedConfigName);

  if (!health.data) return null;

  const selectedConfigLabel =
    selectedConfigName === ""
      ? intl.t("CONFIG.FILES.MAIN")
      : selectedConfigName;
  const metrics = getConfigMetrics(selectedConfig.data?.config);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ServerHealthCard intl={intl} healthData={health.data} />
      <CurrentConfigCard
        intl={intl}
        selectedConfigLabel={selectedConfigLabel}
        selectedConfigPending={selectedConfig.isPending}
        metrics={metrics}
      />
    </div>
  );
}
