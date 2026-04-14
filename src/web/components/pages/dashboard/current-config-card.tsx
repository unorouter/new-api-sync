import { Row } from "@web/components/elements/row";
import { useIntl } from "@web/components/provider/intl-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import type { ConfigMetrics } from "@web/hooks/ui/dashboard-config-metrics-hook";

export function CurrentConfigCard(props: {
  intl: ReturnType<typeof useIntl>;
  selectedConfigLabel: string;
  selectedConfigPending: boolean;
  metrics: ConfigMetrics;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.intl.t("HEALTH.CONFIG_TITLE")}</CardTitle>
        <CardDescription>
          {props.intl.t("HEALTH.CONFIG_DESCRIPTION")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1 text-sm">
          <Row label={props.intl.t("HEALTH.SELECTED_CONFIG")}>
            {props.selectedConfigLabel}
          </Row>
          <Row label={props.intl.t("HEALTH.PROVIDERS")}>
            {props.metrics.providerBreakdown?.total ?? 0}
          </Row>
          <Row label={props.intl.t("HEALTH.PROVIDERS_BREAKDOWN")}>
            <span className="text-muted-foreground text-xs">
              {props.metrics.providerBreakdown
                ? props.intl.t("HEALTH.PROVIDERS_BREAKDOWN_VALUE", {
                    newapi: props.metrics.providerBreakdown.newapi,
                    sub2api: props.metrics.providerBreakdown.sub2api,
                    direct: props.metrics.providerBreakdown.direct,
                    nvidia: props.metrics.providerBreakdown.nvidia,
                  })
                : props.intl.t("HEALTH.CONFIG_LOADING")}
            </span>
          </Row>
          <Row label={props.intl.t("HEALTH.CONFIG_BLACKLIST_COUNT")}>
            {props.selectedConfigPending
              ? props.intl.t("HEALTH.CONFIG_LOADING")
              : props.metrics.blacklistCount}
          </Row>
          <Row label={props.intl.t("HEALTH.CONFIG_MODEL_MAPPING_COUNT")}>
            {props.selectedConfigPending
              ? props.intl.t("HEALTH.CONFIG_LOADING")
              : props.metrics.modelMappingCount}
          </Row>
          <Row label={props.intl.t("HEALTH.CONFIG_PROVIDER_OVERRIDES_COUNT")}>
            {props.selectedConfigPending
              ? props.intl.t("HEALTH.CONFIG_LOADING")
              : props.metrics.providersWithOverrides}
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}
