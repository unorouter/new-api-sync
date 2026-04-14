import { useTranslations } from "use-intl";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";
import { Skeleton } from "@web/components/ui/skeleton";
import { useHistoryRun } from "@web/hooks/history-hook";
import { useUiStore } from "@web/store/ui-store";
import { ChevronLeftIcon } from "lucide-react";

interface Props {
  id: string;
  onBack: () => void;
}

type Filter = "all" | "passed" | "failed";

export function RunDetail(props: Props) {
  const t = useTranslations();
  const run = useHistoryRun(props.id);
  const filter = useUiStore((s) => s.runResultFilter);
  const setFilter = useUiStore((s) => s.setRunResultFilter);
  const query = useUiStore((s) => s.runQuery);
  const setQuery = useUiStore((s) => s.setRunQuery);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={props.onBack}>
          <ChevronLeftIcon />
          {t("HISTORY.RUN.BACK")}
        </Button>
        <span className="text-muted-foreground font-mono text-xs">
          {props.id}
        </span>
      </div>

      {run.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : run.error ? (
        <p className="text-destructive text-sm">
          {t("HISTORY.RUN.LOAD_ERROR", { error: String(run.error) })}
        </p>
      ) : !run.data || run.data.results.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("HISTORY.RUN.EMPTY")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={filter}
              onValueChange={(value) => {
                if (value === null) return;
                setFilter(value as Filter);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("HISTORY.RUN.FILTER_ALL")}
                </SelectItem>
                <SelectItem value="passed">
                  {t("HISTORY.RUN.FILTER_PASSED")}
                </SelectItem>
                <SelectItem value="failed">
                  {t("HISTORY.RUN.FILTER_FAILED")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("HISTORY.RUN.FILTER_PLACEHOLDER")}
              className="max-w-80"
            />
          </div>
          <ResultsTable
            results={run.data.results}
            filter={filter}
            query={query}
          />
        </>
      )}
    </div>
  );
}

interface Result {
  provider: string;
  model: string;
  cost: number | null;
  http: { pass: boolean; error?: string };
  authentic: boolean | null;
}

function ResultsTable(props: {
  results: Result[];
  filter: Filter;
  query: string;
}) {
  const t = useTranslations();
  const q = props.query.trim().toLowerCase();
  const filtered = props.results.filter((r) => {
    if (props.filter === "passed" && !r.http.pass) return false;
    if (props.filter === "failed" && r.http.pass) return false;
    if (q && !`${r.provider} ${r.model}`.toLowerCase().includes(q))
      return false;
    return true;
  });

  if (filtered.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("HISTORY.RUN.EMPTY")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>
              {t("HISTORY.RUN.COL_PROVIDER")}
            </th>
            <th>
              {t("HISTORY.RUN.COL_MODEL")}
            </th>
            <th>
              {t("HISTORY.RUN.COL_STATUS")}
            </th>
            <th className="text-right">
              {t("HISTORY.RUN.COL_COST")}
            </th>
            <th>
              {t("HISTORY.RUN.COL_AUTHENTIC")}
            </th>
            <th>
              {t("HISTORY.RUN.COL_ERROR")}
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r, i) => (
            <tr key={i} className="border-t [&>td]:px-3 [&>td]:py-2">
              <td className="font-mono text-xs">{r.provider}</td>
              <td className="font-mono text-xs">{r.model}</td>
              <td>
                <Badge variant={r.http.pass ? "default" : "destructive"}>
                  {t(
                    r.http.pass
                      ? "HISTORY.RUN.STATUS_PASS"
                      : "HISTORY.RUN.STATUS_FAIL",
                  )}
                </Badge>
              </td>
              <td className="text-right font-mono text-xs">
                {r.cost !== null ? r.cost.toFixed(6) : ""}
              </td>
              <td>
                {r.authentic === true ? (
                  <Badge variant="default">{t("HISTORY.RUN.BADGE_YES")}</Badge>
                ) : r.authentic === false ? (
                  <Badge variant="destructive">{t("HISTORY.RUN.BADGE_NO")}</Badge>
                ) : null}
              </td>
              <td className="text-muted-foreground max-w-96 truncate text-xs">
                {r.http.error ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
