import { FormattedMessage, useIntl } from "@web/lib/intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Button } from "@web/components/ui/button";
import { Badge } from "@web/components/ui/badge";
import { useResetPipeline } from "@web/hooks/reset-hook";
import { useSyncPipeline } from "@web/hooks/sync-hook";
import { useSyncStore, type SyncPhase } from "@web/store/sync-store";

function PhaseBadge(props: { phase: SyncPhase }) {
  if (props.phase === "running")
    return (
      <Badge variant="secondary">
        <FormattedMessage id="SYNC.PHASE.RUNNING" />
      </Badge>
    );
  if (props.phase === "done")
    return (
      <Badge>
        <FormattedMessage id="SYNC.PHASE.DONE" />
      </Badge>
    );
  if (props.phase === "error")
    return (
      <Badge variant="destructive">
        <FormattedMessage id="SYNC.PHASE.ERROR" />
      </Badge>
    );
  return null;
}

function levelClass(level: string): string {
  if (level === "error" || level === "fatal") return "text-destructive";
  if (level === "warn") return "text-yellow-600 dark:text-yellow-400";
  if (level === "success") return "text-green-600 dark:text-green-400";
  if (level === "debug") return "text-muted-foreground";
  return "";
}

export function SyncPanel() {
  const intl = useIntl();
  const phase = useSyncStore((s) => s.phase);
  const mode = useSyncStore((s) => s.mode);
  const logs = useSyncStore((s) => s.logs);
  const error = useSyncStore((s) => s.error);
  const storeReset = useSyncStore((s) => s.reset);

  const sync = useSyncPipeline();
  const resetMutation = useResetPipeline();

  const busy = phase === "running";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FormattedMessage id="SYNC.TITLE" />
          <PhaseBadge phase={phase} />
          {mode ? (
            <span className="text-muted-foreground text-xs font-normal">
              {mode}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          <FormattedMessage id="SYNC.DESCRIPTION" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => sync.mutate({ mode: "run" })} disabled={busy}>
            <FormattedMessage id="SYNC.RUN" />
          </Button>
          <Button
            variant="secondary"
            onClick={() => sync.mutate({ mode: "test" })}
            disabled={busy}
          >
            <FormattedMessage id="SYNC.TEST" />
          </Button>
          <Button
            variant="destructive"
            onClick={() => resetMutation.mutate({})}
            disabled={busy}
          >
            <FormattedMessage id="SYNC.RESET" />
          </Button>
          <Button
            variant="outline"
            onClick={() => storeReset()}
            disabled={busy || phase === "idle"}
          >
            <FormattedMessage id="SYNC.CLEAR_LOG" />
          </Button>
        </div>

        {error ? (
          <p className="text-destructive text-sm">
            {intl.formatMessage({ id: "SYNC.ERROR" }, { error })}
          </p>
        ) : null}

        <div className="bg-muted/40 border-border max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">
              <FormattedMessage
                id={
                  phase === "idle" ? "SYNC.EMPTY_IDLE" : "SYNC.EMPTY_WAITING"
                }
              />
            </p>
          ) : (
            <ul className="space-y-0.5">
              {logs.map((log) => (
                <li key={log.id} className={levelClass(log.level)}>
                  <span className="text-muted-foreground mr-2">
                    [{log.level}]
                  </span>
                  {log.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
