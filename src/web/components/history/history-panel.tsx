import { FormattedMessage } from "@web/components/provider/intl-provider";
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
import { useState } from "react";
import { KiroTable } from "./kiro-table";
import { RunDetail } from "./run-detail";
import { RunsTable } from "./runs-table";

export function HistoryPanel() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <FormattedMessage id="HISTORY.TITLE" />
        </CardTitle>
        <CardDescription>
          <FormattedMessage id="HISTORY.DESCRIPTION" />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="runs">
          <TabsList>
            <TabsTrigger value="runs">
              <FormattedMessage id="HISTORY.TABS.RUNS" />
            </TabsTrigger>
            <TabsTrigger value="kiro">
              <FormattedMessage id="HISTORY.TABS.KIRO" />
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
