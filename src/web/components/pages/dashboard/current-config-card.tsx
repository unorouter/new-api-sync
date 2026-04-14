import { useIntl } from "@web/components/provider/intl-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";

function Row(props: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground w-32 shrink-0">{props.label}</dt>
      <dd className="font-mono min-w-0">{props.children}</dd>
    </div>
  );
}

export type ConfigMetrics = {
  blacklistCount: number;
  modelMappingCount: number;
  providersWithOverrides: number;
  providerBreakdown: {
    newapi: number;
    sub2api: number;
    direct: number;
    nvidia: number;
    total: number;
  } | null;
};

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
        <CardDescription>{props.intl.t("HEALTH.CONFIG_DESCRIPTION")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1 text-sm">
          <Row label={props.intl.t("HEALTH.SELECTED_CONFIG")}>{props.selectedConfigLabel}</Row>
          <Row label={props.intl.t("HEALTH.PROVIDERS")}>{props.metrics.providerBreakdown?.total ?? 0}</Row>
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
