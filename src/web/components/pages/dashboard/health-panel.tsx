import { useTranslations } from "use-intl";
import { useHealth } from "@web/hooks/health-hook";
import { useDashboardConfigMetrics } from "@web/hooks/ui/dashboard-config-metrics-hook";
import { useUiStore } from "@web/store/ui-store";
import { CurrentConfigCard } from "./current-config-card";
import { ServerHealthCard } from "./server-health-card";

export function HealthPanel() {
  const t = useTranslations();
  const health = useHealth();
  const selectedConfigName = useUiStore((state) => state.selectedConfigName);
  const dashboardConfig = useDashboardConfigMetrics(selectedConfigName);

  if (!health.data) return null;

  const selectedConfigLabel =
    selectedConfigName === ""
      ? t("CONFIG.FILES.MAIN")
      : selectedConfigName;
  const metrics = dashboardConfig.metrics;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ServerHealthCard healthData={health.data} />
      <CurrentConfigCard
        selectedConfigLabel={selectedConfigLabel}
        selectedConfigPending={dashboardConfig.selectedConfig.isPending}
        metrics={metrics}
      />
    </div>
  );
}
