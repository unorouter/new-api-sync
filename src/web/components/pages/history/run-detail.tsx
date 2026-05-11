import { useState } from "react";
import { useTranslations } from "use-intl";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
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
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";

interface Props {
  id: string;
  onBack: () => void;
}

type Filter = "all" | "passed" | "failed";

export function RunDetail(props: Props) {
  const t = useTranslations();
  const run = useHistoryRun(props.id);

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
      ) : !run.data ? (
        <p className="text-muted-foreground text-sm">
          {t("HISTORY.RUN.EMPTY")}
        </p>
      ) : (
        <RunBody data={run.data} />
      )}
    </div>
  );
}

interface RunData {
  id: string;
  timestamp: string;
  results: Result[];
  summary?: RunOutcome;
  providers?: Record<string, ProviderEntry>;
  pricingGate?: PricingGate[];
  openrouterEndpoints?: EndpointsLog[];
}

function RunBody(props: { data: RunData }) {
  const t = useTranslations();
  const data = props.data;
  const hasResults = data.results.length > 0;
  const hasSummary = !!data.summary || !!data.providers;
  const hasPricing = !!data.pricingGate && data.pricingGate.length > 0;
  const hasEndpoints =
    !!data.openrouterEndpoints && data.openrouterEndpoints.length > 0;

  // If the report has nothing at all, fall back to the original empty state.
  if (!hasResults && !hasSummary && !hasPricing && !hasEndpoints) {
    return (
      <p className="text-muted-foreground text-sm">{t("HISTORY.RUN.EMPTY")}</p>
    );
  }

  return (
    <Tabs defaultValue={hasSummary ? "summary" : "results"}>
      <TabsList variant="line">
        {hasSummary ? (
          <TabsTrigger value="summary">
            {t("HISTORY.RUN.TAB_SUMMARY")}
          </TabsTrigger>
        ) : null}
        <TabsTrigger value="results">
          {t("HISTORY.RUN.TAB_RESULTS")}
        </TabsTrigger>
        {hasPricing ? (
          <TabsTrigger value="pricing">
            {t("HISTORY.RUN.TAB_PRICING")}
          </TabsTrigger>
        ) : null}
        {hasEndpoints ? (
          <TabsTrigger value="endpoints">
            {t("HISTORY.RUN.TAB_ENDPOINTS")}
          </TabsTrigger>
        ) : null}
      </TabsList>

      {hasSummary ? (
        <TabsContent value="summary" className="mt-3">
          <SummaryView summary={data.summary} providers={data.providers} />
        </TabsContent>
      ) : null}

      <TabsContent value="results" className="mt-3">
        <ResultsView results={data.results} />
      </TabsContent>

      {hasPricing ? (
        <TabsContent value="pricing" className="mt-3">
          <PricingGateView entries={data.pricingGate!} />
        </TabsContent>
      ) : null}

      {hasEndpoints ? (
        <TabsContent value="endpoints" className="mt-3">
          <EndpointsView entries={data.openrouterEndpoints!} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Summary tab — run-level outcome + per-provider counters
// ---------------------------------------------------------------------------

type ChangeSet =
  | { created: string[]; updated: string[]; deleted: string[] }
  | { created: number; updated: number; deleted: number };

interface RunOutcome {
  providers: { passed: number; total: number };
  channels: ChangeSet;
  models: ChangeSet & { orphansDeleted: number };
  options?: { updated: string[] };
  optionsUpdated?: number;
  elapsedSeconds: number;
  success: boolean;
  errors?: { phase: string; key: string; message: string }[];
}

interface ProviderEntry {
  testCost?: number;
  success?: boolean;
  error?: string;
  channels?: ChangeSet;
  groups?: number;
  models?: number;
  tokens?: { created: number; existing: number; deleted: number };
}

function changeCount(
  set: ChangeSet,
  op: "created" | "updated" | "deleted",
): number {
  const value = set[op];
  return Array.isArray(value) ? value.length : value;
}

function SummaryView(props: {
  summary?: RunOutcome;
  providers?: Record<string, ProviderEntry>;
}) {
  const t = useTranslations();
  const summary = props.summary;
  const providers = props.providers ? Object.entries(props.providers) : [];

  return (
    <div className="space-y-4">
      {summary ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {t("HISTORY.RUN.SUMMARY.TITLE")}
              <Badge variant={summary.success ? "default" : "destructive"}>
                {summary.success
                  ? t("HISTORY.RUN.SUMMARY.SUCCESS")
                  : t("HISTORY.RUN.SUMMARY.FAILURE")}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              <Stat
                label={t("HISTORY.RUN.SUMMARY.PROVIDERS")}
                value={`${summary.providers.passed}/${summary.providers.total}`}
              />
              <Stat
                label={t("HISTORY.RUN.SUMMARY.ELAPSED")}
                value={`${summary.elapsedSeconds.toFixed(2)}s`}
              />
              <Stat
                label={t("HISTORY.RUN.SUMMARY.OPTIONS")}
                value={
                  summary.options?.updated.length ?? summary.optionsUpdated ?? 0
                }
              />
              <Stat
                label={t("HISTORY.RUN.SUMMARY.CHANNELS")}
                value={t("HISTORY.RUN.SUMMARY.CRUD_TRIPLE", {
                  created: changeCount(summary.channels, "created"),
                  updated: changeCount(summary.channels, "updated"),
                  deleted: changeCount(summary.channels, "deleted"),
                })}
              />
              <Stat
                label={t("HISTORY.RUN.SUMMARY.MODELS")}
                value={t("HISTORY.RUN.SUMMARY.CRUD_TRIPLE", {
                  created: changeCount(summary.models, "created"),
                  updated: changeCount(summary.models, "updated"),
                  deleted: changeCount(summary.models, "deleted"),
                })}
              />
              <Stat
                label={t("HISTORY.RUN.SUMMARY.ORPHANS")}
                value={summary.models.orphansDeleted}
              />
            </div>

            {summary.errors && summary.errors.length > 0 ? (
              <div className="mt-4 space-y-1">
                <p className="text-destructive text-xs font-medium">
                  {t("HISTORY.RUN.SUMMARY.ERRORS")}
                </p>
                <ul className="text-destructive space-y-1 text-xs">
                  {summary.errors.map((e, i) => (
                    <li key={i} className="font-mono">
                      [{e.phase}/{e.key}] {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {providers.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("HISTORY.RUN.SUMMARY.PROVIDERS_TABLE")}
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr className="border-b">
                  <th className="px-2 py-2 text-left font-medium">
                    {t("HISTORY.RUN.SUMMARY.COL_NAME")}
                  </th>
                  <th className="px-2 py-2 text-left font-medium">
                    {t("HISTORY.RUN.SUMMARY.COL_STATUS")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("HISTORY.RUN.SUMMARY.COL_GROUPS")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("HISTORY.RUN.SUMMARY.COL_MODELS")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("HISTORY.RUN.SUMMARY.COL_TOKENS")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("HISTORY.RUN.SUMMARY.COL_CHANNELS")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {t("HISTORY.RUN.SUMMARY.COL_COST")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {providers.map(([name, entry]) => (
                  <tr key={name} className="border-b last:border-b-0">
                    <td className="px-2 py-2 font-mono">{name}</td>
                    <td className="px-2 py-2">
                      {entry.success === undefined ? (
                        <span className="text-muted-foreground">—</span>
                      ) : entry.success ? (
                        <Badge variant="default" className="text-[10px]">
                          {t("HISTORY.RUN.SUMMARY.OK")}
                        </Badge>
                      ) : (
                        <span className="text-destructive flex items-center gap-1 text-xs">
                          <Badge variant="destructive" className="text-[10px]">
                            {t("HISTORY.RUN.SUMMARY.FAIL")}
                          </Badge>
                          {entry.error ? (
                            <span className="max-w-72 truncate font-mono">
                              {entry.error}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {entry.groups ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {entry.models ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {entry.tokens
                        ? t("HISTORY.RUN.SUMMARY.TOKENS_TRIPLE", {
                            created: entry.tokens.created,
                            existing: entry.tokens.existing,
                            deleted: entry.tokens.deleted,
                          })
                        : "—"}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {entry.channels
                        ? t("HISTORY.RUN.SUMMARY.CRUD_TRIPLE", {
                            created: changeCount(entry.channels, "created"),
                            updated: changeCount(entry.channels, "updated"),
                            deleted: changeCount(entry.channels, "deleted"),
                          })
                        : "—"}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {entry.testCost !== undefined
                        ? `$${entry.testCost.toFixed(4)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat(props: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-xs">{props.label}</span>
      <span className="font-mono">{props.value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results tab — model test rows (the legacy view)
// ---------------------------------------------------------------------------

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

function ResultsView(props: { results: Result[] }) {
  const t = useTranslations();
  const filter = useUiStore((s) => s.runResultFilter);
  const setFilter = useUiStore((s) => s.setRunResultFilter);
  const query = useUiStore((s) => s.runQuery);
  const setQuery = useUiStore((s) => s.setRunQuery);

  if (props.results.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">{t("HISTORY.RUN.EMPTY")}</p>
    );
  }

  return (
    <div className="space-y-3">
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
            <SelectItem value="all">{t("HISTORY.RUN.FILTER_ALL")}</SelectItem>
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
      <ResultsTable results={props.results} filter={filter} query={query} />
    </div>
  );
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
      <p className="text-muted-foreground text-sm">{t("HISTORY.RUN.EMPTY")}</p>
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

  const hasTabs = r.stream !== null || r.toolCall !== null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border">
        <CollapsibleTrigger className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm">
          <ChevronRightIcon
            className={`size-4 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          <span className="min-w-24 font-mono text-xs">{r.provider}</span>
          <span className="flex-1 font-mono text-xs">{r.model}</span>

          <ExchangeBadge label="H" exchange={r.http} />
          {r.stream !== null && <ExchangeBadge label="S" exchange={r.stream} />}
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
    <Badge variant={variant} className="px-1.5 font-mono text-[10px]">
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
          {ex.pass
            ? t("HISTORY.RUN.STATUS_PASS")
            : t("HISTORY.RUN.STATUS_FAIL")}
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
        {ex.error && <span className="text-destructive">{ex.error}</span>}
      </div>

      <div className="text-muted-foreground font-mono text-xs break-all">
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
    <pre className="bg-muted max-h-96 overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
      {text}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Pricing gate tab — voted canonical + per-source candidates
// ---------------------------------------------------------------------------

interface PricingGate {
  exposed: string;
  vote: {
    candidates: {
      source: string;
      matchedKey?: string;
      modelRatio?: number;
      completionRatio?: number;
      inputUsdPerM?: number;
      outputUsdPerM?: number;
    }[];
    cluster: {
      members: string[];
      modelRatio: number;
      completionRatio: number;
      inputUsdPerM: number;
      outputUsdPerM: number;
    } | null;
    decision: string;
  };
}

function PricingGateView(props: { entries: PricingGate[] }) {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<string>("all");

  const q = query.trim().toLowerCase();
  const filtered = props.entries.filter((e) => {
    if (decisionFilter !== "all" && e.vote.decision !== decisionFilter)
      return false;
    if (q && !e.exposed.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={decisionFilter}
          onValueChange={(v) => v && setDecisionFilter(v)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("HISTORY.RUN.PRICING.FILTER_ALL")}
            </SelectItem>
            <SelectItem value="voted">
              {t("HISTORY.RUN.PRICING.FILTER_VOTED")}
            </SelectItem>
            <SelectItem value="no-majority">
              {t("HISTORY.RUN.PRICING.FILTER_NO_MAJORITY")}
            </SelectItem>
            <SelectItem value="no-matches">
              {t("HISTORY.RUN.PRICING.FILTER_NO_MATCHES")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("HISTORY.RUN.PRICING.FILTER_PLACEHOLDER")}
          className="max-w-80"
        />
        <span className="text-muted-foreground text-xs">
          {t("HISTORY.RUN.PRICING.COUNT", {
            shown: filtered.length,
            total: props.entries.length,
          })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("HISTORY.RUN.EMPTY")}
        </p>
      ) : (
        <div className="space-y-1">
          {filtered.map((entry, i) => (
            <PricingGateRow key={i} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function decisionVariant(
  decision: string,
): "default" | "secondary" | "destructive" {
  if (decision === "voted") return "default";
  if (decision === "no-majority") return "secondary";
  return "destructive";
}

function PricingGateRow(props: { entry: PricingGate }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const e = props.entry;
  const cluster = e.vote.cluster;
  const matchedCount = e.vote.candidates.filter(
    (c) => c.modelRatio !== undefined,
  ).length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border">
        <CollapsibleTrigger className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm">
          <ChevronRightIcon
            className={`size-4 shrink-0 transition-transform duration-200 ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className="flex-1 font-mono text-xs">{e.exposed}</span>
          <Badge
            variant={decisionVariant(e.vote.decision)}
            className="text-[10px]"
          >
            {e.vote.decision}
          </Badge>
          {cluster ? (
            <span className="text-muted-foreground font-mono text-xs">
              ${cluster.inputUsdPerM.toFixed(2)}
              {" / "}${cluster.outputUsdPerM.toFixed(2)}
              {" /M ("}
              {cluster.members.length}
              {")"}
            </span>
          ) : (
            <span className="text-muted-foreground font-mono text-xs">
              {t("HISTORY.RUN.PRICING.MATCHED_OF", {
                matched: matchedCount,
                total: e.vote.candidates.length,
              })}
            </span>
          )}
        </CollapsibleTrigger>

        <CollapsiblePanel>
          <div className="overflow-x-auto border-t">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">
                    {t("HISTORY.RUN.PRICING.COL_SOURCE")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("HISTORY.RUN.PRICING.COL_KEY")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("HISTORY.RUN.PRICING.COL_INPUT")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("HISTORY.RUN.PRICING.COL_OUTPUT")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("HISTORY.RUN.PRICING.COL_RATIO")}
                  </th>
                  <th className="px-3 py-2 text-center font-medium">
                    {t("HISTORY.RUN.PRICING.COL_IN_CLUSTER")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.vote.candidates.map((c, i) => {
                  const inCluster = cluster?.members.includes(c.source);
                  return (
                    <tr
                      key={i}
                      className={
                        inCluster
                          ? "bg-muted/30 border-b last:border-b-0"
                          : "border-b last:border-b-0"
                      }
                    >
                      <td className="px-3 py-2 font-mono">{c.source}</td>
                      <td className="px-3 py-2 font-mono">
                        {c.matchedKey ?? (
                          <span className="text-muted-foreground italic">
                            {t("HISTORY.RUN.PRICING.NO_MATCH")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {c.inputUsdPerM !== undefined
                          ? `$${c.inputUsdPerM.toFixed(2)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {c.outputUsdPerM !== undefined
                          ? `$${c.outputUsdPerM.toFixed(2)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {c.modelRatio !== undefined
                          ? c.modelRatio.toFixed(4)
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {inCluster ? "✓" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// OpenRouter endpoints tab — per-model endpoint snapshot
// ---------------------------------------------------------------------------

interface EndpointsLog {
  id: string;
  endpoints: {
    provider: string;
    quantization?: string;
    prompt: number;
    completion: number;
    discount: number;
    effectivePrompt: number;
    effectiveCompletion: number;
  }[];
  picked?: {
    provider: string;
    promptUsd: number;
    completionUsd: number;
  };
}

function EndpointsView(props: { entries: EndpointsLog[] }) {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = props.entries.filter(
    (e) => !q || e.id.toLowerCase().includes(q),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("HISTORY.RUN.ENDPOINTS.FILTER_PLACEHOLDER")}
          className="max-w-80"
        />
        <span className="text-muted-foreground text-xs">
          {t("HISTORY.RUN.ENDPOINTS.COUNT", {
            shown: filtered.length,
            total: props.entries.length,
          })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("HISTORY.RUN.EMPTY")}
        </p>
      ) : (
        <div className="space-y-1">
          {filtered.map((entry, i) => (
            <EndpointsRow key={i} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function EndpointsRow(props: { entry: EndpointsLog }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const e = props.entry;

  // USD-per-token is hard to read; convert to per-million for display.
  const toM = (perToken: number) => perToken * 1_000_000;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border">
        <CollapsibleTrigger className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm">
          <ChevronRightIcon
            className={`size-4 shrink-0 transition-transform duration-200 ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className="flex-1 font-mono text-xs">{e.id}</span>
          <span className="text-muted-foreground font-mono text-xs">
            {e.endpoints.length}
          </span>
          {e.picked ? (
            <Badge variant="default" className="text-[10px]">
              ${toM(e.picked.promptUsd).toFixed(2)}
              {" / "}${toM(e.picked.completionUsd).toFixed(2)}
              {" /M"}
            </Badge>
          ) : null}
        </CollapsibleTrigger>

        <CollapsiblePanel>
          <div className="overflow-x-auto border-t">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">
                    {t("HISTORY.RUN.ENDPOINTS.COL_PROVIDER")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("HISTORY.RUN.ENDPOINTS.COL_QUANT")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("HISTORY.RUN.ENDPOINTS.COL_PROMPT")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("HISTORY.RUN.ENDPOINTS.COL_COMPLETION")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("HISTORY.RUN.ENDPOINTS.COL_DISCOUNT")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("HISTORY.RUN.ENDPOINTS.COL_EFFECTIVE")}
                  </th>
                  <th className="px-3 py-2 text-center font-medium">
                    {t("HISTORY.RUN.ENDPOINTS.COL_PICKED")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.endpoints.map((row, i) => {
                  const picked =
                    e.picked?.provider === row.provider &&
                    Math.abs(
                      toM(row.effectivePrompt) - toM(e.picked.promptUsd),
                    ) < 1e-9;
                  return (
                    <tr
                      key={i}
                      className={
                        picked
                          ? "bg-muted/30 border-b last:border-b-0"
                          : "border-b last:border-b-0"
                      }
                    >
                      <td className="px-3 py-2 font-mono">{row.provider}</td>
                      <td className="px-3 py-2 font-mono">
                        {row.quantization ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        ${toM(row.prompt).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        ${toM(row.completion).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {row.discount > 0
                          ? `-${(row.discount * 100).toFixed(0)}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        ${toM(row.effectivePrompt).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {picked ? "✓" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}
