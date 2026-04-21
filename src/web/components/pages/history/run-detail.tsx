import { useState } from "react";
import { useTranslations } from "use-intl";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@web/components/ui/collapsible";
import { Input } from "@web/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";
import { Skeleton } from "@web/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@web/components/ui/tabs";
import { useHistoryRun } from "@web/hooks/history-hook";
import { useUiStore } from "@web/store/ui-store";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

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

interface Exchange {
  pass: boolean;
  request: {
    url: string;
    headers?: Record<string, string>;
    body: unknown;
  };
  response: unknown;
  responseHeaders?: Record<string, string>;
  error?: string;
  status?: number;
  latencyMs?: number;
}

interface Result {
  provider: string;
  model: string;
  cost: number | null;
  http: Exchange;
  stream: Exchange | null;
  toolCall: Exchange | null;
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
    <div className="space-y-1">
      {filtered.map((r, i) => (
        <ResultRow key={i} result={r} />
      ))}
    </div>
  );
}

function ResultRow(props: { result: Result }) {
  const t = useTranslations();
  const r = props.result;
  const [open, setOpen] = useState(false);

  const hasTabs =
    r.stream !== null || r.toolCall !== null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border">
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50">
          <ChevronRightIcon
            className={`size-4 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          <span className="font-mono text-xs min-w-24">{r.provider}</span>
          <span className="font-mono text-xs flex-1">{r.model}</span>

          <ExchangeBadge label="H" exchange={r.http} />
          {r.stream !== null && (
            <ExchangeBadge label="S" exchange={r.stream} />
          )}
          {r.toolCall !== null && (
            <ExchangeBadge label="T" exchange={r.toolCall} />
          )}

          {r.authentic === true && (
            <Badge variant="default" className="text-[10px]">
              {t("HISTORY.RUN.BADGE_YES")}
            </Badge>
          )}
          {r.authentic === false && (
            <Badge variant="destructive" className="text-[10px]">
              {t("HISTORY.RUN.BADGE_NO")}
            </Badge>
          )}

          {r.http.latencyMs !== undefined && (
            <span className="text-muted-foreground font-mono text-xs">
              {r.http.latencyMs}ms
            </span>
          )}

          {r.cost !== null && (
            <span className="text-muted-foreground font-mono text-xs">
              ${r.cost.toFixed(6)}
            </span>
          )}

          {r.http.error && !r.http.pass && (
            <span className="text-destructive max-w-48 truncate text-xs">
              {r.http.error}
            </span>
          )}
        </CollapsibleTrigger>

        <CollapsiblePanel>
          <div className="border-t px-3 py-3">
            {hasTabs ? (
              <Tabs defaultValue="http">
                <TabsList variant="line">
                  <TabsTrigger value="http">
                    {t("HISTORY.RUN.TAB_HTTP")}
                  </TabsTrigger>
                  {r.stream !== null && (
                    <TabsTrigger value="stream">
                      {t("HISTORY.RUN.TAB_STREAM")}
                    </TabsTrigger>
                  )}
                  {r.toolCall !== null && (
                    <TabsTrigger value="tool">
                      {t("HISTORY.RUN.TAB_TOOL")}
                    </TabsTrigger>
                  )}
                </TabsList>
                <TabsContent value="http" className="mt-3">
                  <ExchangeDetail exchange={r.http} />
                </TabsContent>
                {r.stream !== null && (
                  <TabsContent value="stream" className="mt-3">
                    <ExchangeDetail exchange={r.stream} />
                  </TabsContent>
                )}
                {r.toolCall !== null && (
                  <TabsContent value="tool" className="mt-3">
                    <ExchangeDetail exchange={r.toolCall} />
                  </TabsContent>
                )}
              </Tabs>
            ) : (
              <ExchangeDetail exchange={r.http} />
            )}
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

function ExchangeBadge(props: { label: string; exchange: Exchange }) {
  const variant = props.exchange.pass ? "default" : "destructive";
  return (
    <Badge variant={variant} className="font-mono text-[10px] px-1.5">
      {props.label}
      {props.exchange.status ? ` ${props.exchange.status}` : ""}
    </Badge>
  );
}

function ExchangeDetail(props: { exchange: Exchange }) {
  const t = useTranslations();
  const ex = props.exchange;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <Badge variant={ex.pass ? "default" : "destructive"}>
          {ex.pass ? t("HISTORY.RUN.STATUS_PASS") : t("HISTORY.RUN.STATUS_FAIL")}
        </Badge>
        {ex.status !== undefined && (
          <span className="text-muted-foreground font-mono">
            {t("HISTORY.RUN.STATUS_CODE", { code: ex.status })}
          </span>
        )}
        {ex.latencyMs !== undefined && (
          <span className="text-muted-foreground font-mono">
            {t("HISTORY.RUN.LATENCY_MS", { ms: ex.latencyMs })}
          </span>
        )}
        {ex.error && (
          <span className="text-destructive">{ex.error}</span>
        )}
      </div>

      <div className="font-mono text-xs break-all text-muted-foreground">
        POST {ex.request.url}
      </div>

      {ex.request.headers && Object.keys(ex.request.headers).length > 0 && (
        <DetailSection title={t("HISTORY.RUN.REQUEST_HEADERS")}>
          <HeadersTable headers={ex.request.headers} />
        </DetailSection>
      )}

      {ex.request.body !== null && ex.request.body !== undefined && (
        <DetailSection title={t("HISTORY.RUN.REQUEST_BODY")}>
          <JsonBlock data={ex.request.body} />
        </DetailSection>
      )}

      {ex.responseHeaders && Object.keys(ex.responseHeaders).length > 0 && (
        <DetailSection title={t("HISTORY.RUN.RESPONSE_HEADERS")}>
          <HeadersTable headers={ex.responseHeaders} />
        </DetailSection>
      )}

      <DetailSection title={t("HISTORY.RUN.RESPONSE_BODY")}>
        {ex.response !== null && ex.response !== undefined ? (
          typeof ex.response === "string" ? (
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
              {ex.response}
            </pre>
          ) : (
            <JsonBlock data={ex.response} />
          )
        ) : (
          <p className="text-muted-foreground text-xs italic">
            {t("HISTORY.RUN.NO_DATA")}
          </p>
        )}
      </DetailSection>
    </div>
  );
}

function DetailSection(props: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-xs font-medium hover:underline">
        <ChevronDownIcon
          className={`size-3 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
        {props.title}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function HeadersTable(props: { headers: Record<string, string> }) {
  const entries = Object.entries(props.headers);
  return (
    <div className="bg-muted overflow-x-auto rounded-md p-2">
      <table className="text-xs">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td className="text-muted-foreground pr-3 align-top font-mono whitespace-nowrap">
                {k}
              </td>
              <td className="font-mono break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonBlock(props: { data: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(props.data, null, 2);
  } catch {
    text = String(props.data);
  }
  return (
    <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs max-h-96 whitespace-pre-wrap">
      {text}
    </pre>
  );
}
