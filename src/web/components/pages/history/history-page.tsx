import { AuthenticityTable } from "./authenticity-table";
import { RunDetail } from "./run-detail";
import { RunsTable } from "./runs-table";
import { useTranslations } from "use-intl";
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
  const t = useTranslations();
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
              setHistoryTab(value as "runs" | "authenticity");
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="runs">
              {t("HISTORY.TABS.RUNS")}
            </TabsTrigger>
            <TabsTrigger value="authenticity">
              {t("HISTORY.TABS.AUTHENTICITY")}
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
          <TabsContent value="authenticity" className="mt-4">
            <AuthenticityTable />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
