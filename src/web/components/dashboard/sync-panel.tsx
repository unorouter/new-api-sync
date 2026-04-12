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

function phaseBadge(phase: SyncPhase) {
  if (phase === "running") return <Badge variant="secondary">running</Badge>;
  if (phase === "done") return <Badge>done</Badge>;
  if (phase === "error") return <Badge variant="destructive">error</Badge>;
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
          Sync pipeline
          {phaseBadge(phase)}
          {mode ? (
            <span className="text-muted-foreground text-xs font-normal">
              {mode}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          Run a full sync, test provider connectivity, or reset managed
          resources.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => sync.mutate({ mode: "run" })}
            disabled={busy}
          >
            Run
          </Button>
          <Button
            variant="secondary"
            onClick={() => sync.mutate({ mode: "test" })}
            disabled={busy}
          >
            Test
          </Button>
          <Button
            variant="destructive"
            onClick={() => resetMutation.mutate({})}
            disabled={busy}
          >
            Reset
          </Button>
          <Button
            variant="outline"
            onClick={() => storeReset()}
            disabled={busy || phase === "idle"}
          >
            Clear log
          </Button>
        </div>

        {error ? (
          <p className="text-destructive text-sm">Error: {error}</p>
        ) : null}

        <div className="bg-muted/40 border-border max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">
              {phase === "idle"
                ? "No run yet. Click Run, Test, or Reset to start."
                : "Waiting for output..."}
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
