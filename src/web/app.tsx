import { QueryClientProvider } from "@tanstack/react-query";
import { ConfigEditor } from "@web/components/config/config-editor";
import { ConfigFilesDropdown } from "@web/components/config/config-files-dropdown";
import { SyncPanel } from "@web/components/dashboard/sync-panel";
import { HistoryPanel } from "@web/components/history/history-panel";
import { useUiStore } from "@web/store/ui-store";
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
import { Toaster } from "@web/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@web/components/ui/tabs";
import { useHealth } from "@web/hooks/health-hook";
import getQueryClient from "@web/lib/react-query/client";

const queryClient = getQueryClient();

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

function DashboardTab() {
  return (
    <div className="grid gap-4">
      <HealthPanel />
      <SyncPanel />
    </div>
  );
}

function ConfigTab() {
  return <ConfigEditor />;
}

function HistoryTab() {
  return <HistoryPanel />;
}

export function App() {
  const mainTab = useUiStore((s) => s.mainTab);
  const setMainTab = useUiStore((s) => s.setMainTab);

  return (
    <QueryClientProvider client={queryClient}>
      <main className="mx-auto max-w-5xl p-8">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">
              <FormattedMessage id="APP.TITLE" />
            </h1>
            <p className="text-muted-foreground mt-1">
              <FormattedMessage id="APP.SUBTITLE" />
            </p>
          </div>
          <div className="flex items-center gap-1"></div>
        </header>
        <Tabs
          value={mainTab}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setMainTab(value as "dashboard" | "config" | "history");
            }
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <TabsList>
              <TabsTrigger value="dashboard">
                <FormattedMessage id="TABS.DASHBOARD" />
              </TabsTrigger>
              <TabsTrigger value="config">
                <FormattedMessage id="TABS.CONFIGURATION" />
              </TabsTrigger>
              <TabsTrigger value="history">
                <FormattedMessage id="TABS.HISTORY" />
              </TabsTrigger>
            </TabsList>
            <ConfigFilesDropdown />
          </div>
          <TabsContent value="dashboard" className="mt-6">
            <DashboardTab />
          </TabsContent>
          <TabsContent value="config" className="mt-6">
            <ConfigTab />
          </TabsContent>
          <TabsContent value="history" className="mt-6">
            <HistoryTab />
          </TabsContent>
        </Tabs>
      </main>
      <Toaster />
    </QueryClientProvider>
  );
}
