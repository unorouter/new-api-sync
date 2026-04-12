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
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20">
                <FormattedMessage id="HEALTH.VERSION" />
              </dt>
              <dd className="font-mono">{health.data.version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20">
                <FormattedMessage id="HEALTH.UPTIME" />
              </dt>
              <dd className="font-mono">{health.data.uptime.toFixed(1)}s</dd>
            </div>
          </dl>
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
