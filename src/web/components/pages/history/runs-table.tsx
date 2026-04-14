import { useTranslations } from "use-intl";
import { Badge } from "@web/components/ui/badge";
import { Skeleton } from "@web/components/ui/skeleton";
import { useHistoryRuns } from "@web/hooks/history-hook";

interface Props {
  onSelect: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function RunsTable(props: Props) {
  const t = useTranslations();
  const runs = useHistoryRuns();

  if (runs.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (runs.error) {
    return (
      <p className="text-destructive text-sm">
        {t("HISTORY.RUNS.LOAD_ERROR", { error: String(runs.error) })}
      </p>
    );
  }

  if (!runs.data || runs.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("HISTORY.RUNS.EMPTY")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>
              {t("HISTORY.RUNS.COL_TIMESTAMP")}
            </th>
            <th className="text-right">
              {t("HISTORY.RUNS.COL_PASSED")}
            </th>
            <th className="text-right">
              {t("HISTORY.RUNS.COL_FAILED")}
            </th>
            <th className="text-right">
              {t("HISTORY.RUNS.COL_TOTAL")}
            </th>
            <th className="text-right">
              {t("HISTORY.RUNS.COL_SIZE")}
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.data.map((run) => (
            <tr
              key={run.id}
              onClick={() => props.onSelect(run.id)}
              className="hover:bg-muted/40 cursor-pointer border-t transition-colors [&>td]:px-3 [&>td]:py-2"
            >
              <td className="font-mono text-xs">
                {formatTimestamp(run.timestamp)}
              </td>
              <td className="text-right">
                <Badge variant={run.passed > 0 ? "default" : "secondary"}>
                  {run.passed}
                </Badge>
              </td>
              <td className="text-right">
                <Badge variant={run.failed > 0 ? "destructive" : "secondary"}>
                  {run.failed}
                </Badge>
              </td>
              <td className="text-right">{run.total}</td>
              <td className="text-muted-foreground text-right text-xs">
                {formatSize(run.size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTimestamp(raw: string): string {
  try {
    return new Date(raw).toLocaleString();
  } catch {
    return raw;
  }
}
