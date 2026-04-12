import { KiroTable } from "./kiro-table";
import { RunDetail } from "./run-detail";
import { RunsTable } from "./runs-table";
import { useIntl } from "@web/components/provider/intl-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@web/components/ui/tabs";
import { useUiStore } from "@web/store/ui-store";

export function HistoryPage() {
  const { t } = useIntl();
  const historyTab = useUiStore((s) => s.historyTab);
  const setHistoryTab = useUiStore((s) => s.setHistoryTab);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const setSelectedRunId = useUiStore((s) => s.setSelectedRunId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("HISTORY.TITLE")}
        </CardTitle>
        <CardDescription>
          {t("HISTORY.DESCRIPTION")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs
          value={historyTab}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setHistoryTab(value as "runs" | "kiro");
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="runs">
              {t("HISTORY.TABS.RUNS")}
            </TabsTrigger>
            <TabsTrigger value="kiro">
              {t("HISTORY.TABS.KIRO")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="runs" className="mt-4">
            {selectedRunId ? (
              <RunDetail
                id={selectedRunId}
                onBack={() => setSelectedRunId(null)}
              />
            ) : (
              <RunsTable onSelect={(id) => setSelectedRunId(id)} />
            )}
          </TabsContent>
          <TabsContent value="kiro" className="mt-4">
            <KiroTable />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
