import { QueryClientProvider } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@web/components/ui/tabs";
import { Badge } from "@web/components/ui/badge";
import { Skeleton } from "@web/components/ui/skeleton";
import { Toaster } from "@web/components/ui/sonner";
import { SyncPanel } from "@web/components/dashboard/sync-panel";
import { ConfigEditor } from "@web/components/config/config-editor";
import { useHealth } from "@web/hooks/health-hook";
import getQueryClient from "@web/lib/react-query/client";

const queryClient = getQueryClient();

function HealthPanel() {
  const health = useHealth();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Server health
          {health.data ? (
            <Badge variant={health.data.ok ? "default" : "destructive"}>
              {health.data.ok ? "OK" : "DOWN"}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>Runtime status of the sync server.</CardDescription>
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
            Error: {String(health.error)}
          </p>
        ) : health.data ? (
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20">version</dt>
              <dd className="font-mono">{health.data.version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20">uptime</dt>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>
          Past sync runs and their summaries, stored in logs/.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        (coming soon — list of past runs with diff & report)
      </CardContent>
    </Card>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <main className="mx-auto max-w-5xl p-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold">new-api-sync</h1>
          <p className="text-muted-foreground mt-1">
            Sync pricing, channels, and models from upstream providers.
          </p>
        </header>
        <Tabs defaultValue="dashboard">
          <TabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="config">Configuration</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
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
