import type { HealthData } from "@core/validations/health";
import { Row } from "@web/components/elements/row";
import { useIntl } from "@web/components/provider/intl-provider";
import { Badge } from "@web/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { formatBytes, formatUptime } from "@web/lib/constants";

export function ServerHealthCard(props: { healthData: HealthData }) {
  const { t } = useIntl();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("HEALTH.TITLE")}
          <Badge variant={props.healthData.ok ? "default" : "destructive"}>
            {t(props.healthData.ok ? "HEALTH.OK" : "HEALTH.DOWN")}
          </Badge>
          {props.healthData.activeRuns.length > 0 ? (
            <Badge variant="secondary">
              {t("HEALTH.ACTIVE_RUNS", {
                count: props.healthData.activeRuns.length,
              })}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t("HEALTH.DESCRIPTION")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1 text-sm">
          <Row label={t("HEALTH.VERSION")}>{props.healthData.version}</Row>
          <Row label={t("HEALTH.UPTIME")}>{formatUptime(props.healthData.uptime)}</Row>
          <Row label={t("HEALTH.CONFIG_FILES")}>{props.healthData.config.files}</Row>
          <Row label={t("HEALTH.STARTED_AT")}>
            {new Date(props.healthData.startedAt).toLocaleString()}
          </Row>
          <Row label={t("HEALTH.MEMORY")}>
            {formatBytes(props.healthData.memory.rss)} rss / {formatBytes(props.healthData.memory.heapUsed)} heap
          </Row>
          <Row label={t("HEALTH.PLATFORM")}>
            {props.healthData.runtime.platform} / {props.healthData.runtime.arch}
          </Row>
          <Row label={t("HEALTH.KIRO_BLACKLIST")}>
            {props.healthData.kiroBlacklistSize}
          </Row>
          <Row label={t("HEALTH.LAST_RUN")}>
            {props.healthData.lastRun ? (
              <div className="min-w-0">
                <div>{new Date(props.healthData.lastRun.timestamp).toLocaleString()}</div>
                <div className="text-muted-foreground text-xs">
                  {t("HEALTH.LAST_RUN_SUMMARY", {
                    passed: props.healthData.lastRun.passed,
                    total: props.healthData.lastRun.total,
                    failed: props.healthData.lastRun.failed,
                  })}
                </div>
              </div>
            ) : (
              <span className="text-muted-foreground">{t("HEALTH.NO_RUNS")}</span>
            )}
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}
