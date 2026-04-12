import {
  FormattedMessage,
  useIntl,
} from "@web/components/provider/intl-provider";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@web/components/ui/radio-group";
import { useSyncPipeline } from "@web/hooks/sync-hook";
import { useSyncStore, type SyncPhase } from "@web/store/sync-store";
import { useUiStore, type PipelineMode } from "@web/store/ui-store";
import type { TranslationKey } from "@web/lib/constants";
import { PlayIcon, SquareIcon } from "lucide-react";

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

const MODE_LABELS: Record<PipelineMode, TranslationKey> = {
  run: "SYNC.MODE.RUN",
  test: "SYNC.MODE.TEST",
  reset: "SYNC.MODE.RESET",
};

const MODE_ORDER: PipelineMode[] = ["run", "test", "reset"];

export function SyncPanel() {
  const intl = useIntl();
  const phase = useSyncStore((s) => s.phase);
  const mode = useSyncStore((s) => s.mode);
  const logs = useSyncStore((s) => s.logs);
  const error = useSyncStore((s) => s.error);
  const storeReset = useSyncStore((s) => s.reset);
  const pipelineMode = useUiStore((s) => s.pipelineMode);
  const setPipelineMode = useUiStore((s) => s.setPipelineMode);

  const sync = useSyncPipeline();

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
        <div className="flex flex-wrap items-center gap-4">
          <RadioGroup
            value={pipelineMode}
            onValueChange={(next) => {
              if (typeof next === "string")
                setPipelineMode(next as PipelineMode);
            }}
            className="flex gap-4"
          >
            {MODE_ORDER.map((m) => (
              <label
                key={m}
                className="flex items-center gap-2 text-sm data-disabled:opacity-50"
                data-disabled={busy ? "" : undefined}
              >
                <RadioGroupItem value={m} disabled={busy} />
                <FormattedMessage id={MODE_LABELS[m]} />
              </label>
            ))}
          </RadioGroup>

          {busy ? (
            <Button variant="destructive" onClick={() => sync.stop()}>
              <SquareIcon />
              <FormattedMessage id="SYNC.STOP" />
            </Button>
          ) : (
            <Button
              onClick={() => sync.mutate({ mode: pipelineMode })}
              variant={pipelineMode === "reset" ? "destructive" : "default"}
            >
              <PlayIcon />
              <FormattedMessage id="SYNC.START" />
            </Button>
          )}

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
                id={phase === "idle" ? "SYNC.EMPTY_IDLE" : "SYNC.EMPTY_WAITING"}
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
