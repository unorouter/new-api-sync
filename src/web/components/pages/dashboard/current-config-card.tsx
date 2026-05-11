import { Row } from "@web/components/elements/row";
import { useTranslations } from "use-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import type { ConfigMetrics } from "@web/hooks/ui/dashboard-config-metrics-hook";

export function CurrentConfigCard(props: {
  selectedConfigLabel: string;
  selectedConfigPending: boolean;
  metrics: ConfigMetrics;
}) {
  const t = useTranslations();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("HEALTH.CONFIG_TITLE")}</CardTitle>
        <CardDescription>{t("HEALTH.CONFIG_DESCRIPTION")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1 text-sm">
          <Row label={t("HEALTH.SELECTED_CONFIG")}>
            {props.selectedConfigLabel}
          </Row>
          <Row label={t("HEALTH.PROVIDERS")}>
            {props.metrics.providerBreakdown?.total ?? 0}
          </Row>
          <Row label={t("HEALTH.PROVIDERS_BREAKDOWN")}>
            <span className="text-muted-foreground text-xs">
              {props.metrics.providerBreakdown
                ? t("HEALTH.PROVIDERS_BREAKDOWN_VALUE", {
                    newapi: props.metrics.providerBreakdown.newapi,
                    sub2api: props.metrics.providerBreakdown.sub2api,
                    nvidia: props.metrics.providerBreakdown.nvidia,
                    openrouter: props.metrics.providerBreakdown.openrouter,
                  })
                : t("HEALTH.CONFIG_LOADING")}
            </span>
          </Row>
          <Row label={t("HEALTH.CONFIG_BLACKLIST_COUNT")}>
            {props.selectedConfigPending
              ? t("HEALTH.CONFIG_LOADING")
              : props.metrics.blacklistCount}
          </Row>
          <Row label={t("HEALTH.CONFIG_MODEL_MAPPING_COUNT")}>
            {props.selectedConfigPending
              ? t("HEALTH.CONFIG_LOADING")
              : props.metrics.modelMappingCount}
          </Row>
          <Row label={t("HEALTH.CONFIG_PROVIDER_OVERRIDES_COUNT")}>
            {props.selectedConfigPending
              ? t("HEALTH.CONFIG_LOADING")
              : props.metrics.providersWithOverrides}
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}
