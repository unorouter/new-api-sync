import { SyncPanel } from "@web/components/elements/dashboard/sync-panel";
import {
  FormattedMessage,
  useIntl,
} from "@web/components/provider/intl-provider";
import { Badge } from "@web/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Skeleton } from "@web/components/ui/skeleton";
import { useHealth } from "@web/hooks/health-hook";

/** Humanize bytes into KB/MB/GB so the memory row is readable at a glance. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function Row(props: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground w-32 shrink-0">{props.label}</dt>
      <dd className="font-mono">{props.children}</dd>
    </div>
  );
}

function HealthPanel() {
  const intl = useIntl();
  const health = useHealth();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FormattedMessage id="HEALTH.TITLE" />
          {health.data ? (
            <Badge variant={health.data.ok ? "default" : "destructive"}>
              <FormattedMessage
                id={health.data.ok ? "HEALTH.OK" : "HEALTH.DOWN"}
              />
            </Badge>
          ) : null}
          {health.data && health.data.activeRuns.length > 0 ? (
            <Badge variant="secondary">
              <FormattedMessage
                id="HEALTH.ACTIVE_RUNS"
                values={{ count: health.data.activeRuns.length }}
              />
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          <FormattedMessage id="HEALTH.DESCRIPTION" />
        </CardDescription>
      </CardHeader>
      <CardContent>
        {health.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-24" />
          </div>
        ) : health.error ? (
          <p className="text-destructive text-sm">
            {intl.formatMessage(
              { id: "HEALTH.ERROR" },
              { error: String(health.error) },
            )}
          </p>
        ) : health.data ? (
          <div className="grid gap-6 md:grid-cols-2">
            <dl className="space-y-1 text-sm">
              <Row label={<FormattedMessage id="HEALTH.VERSION" />}>
                {health.data.version}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.UPTIME" />}>
                {formatUptime(health.data.uptime)}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.STARTED_AT" />}>
                {new Date(health.data.startedAt).toLocaleString()}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.BUN" />}>
                {health.data.runtime.bun}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.PLATFORM" />}>
                {health.data.runtime.platform} / {health.data.runtime.arch}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.PID" />}>
                {health.data.runtime.pid}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.MEMORY" />}>
                {formatBytes(health.data.memory.rss)} rss /{" "}
                {formatBytes(health.data.memory.heapUsed)} heap
              </Row>
            </dl>
            <dl className="space-y-1 text-sm">
              <Row label={<FormattedMessage id="HEALTH.CONFIG_FILES" />}>
                {health.data.config.files}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.PROVIDERS" />}>
                {health.data.config.providers.total}
                {health.data.config.providers.total > 0 ? (
                  <span className="text-muted-foreground ml-2 text-xs">
                    ({health.data.config.providers.newapi} newapi,{" "}
                    {health.data.config.providers.sub2api} sub2api,{" "}
                    {health.data.config.providers.direct} direct,{" "}
                    {health.data.config.providers.nvidia} nvidia)
                  </span>
                ) : null}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.KIRO_BLACKLIST" />}>
                {health.data.kiroBlacklistSize}
              </Row>
              <Row label={<FormattedMessage id="HEALTH.LAST_RUN" />}>
                {health.data.lastRun ? (
                  <>
                    {new Date(health.data.lastRun.timestamp).toLocaleString()}
                    <span className="text-muted-foreground ml-2 text-xs">
                      ({health.data.lastRun.passed}/
                      {health.data.lastRun.total} passed,{" "}
                      {health.data.lastRun.failed} failed)
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    <FormattedMessage id="HEALTH.NO_RUNS" />
                  </span>
                )}
              </Row>
            </dl>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  return (
    <div className="grid gap-4">
      <HealthPanel />
      <SyncPanel />
    </div>
  );
}
