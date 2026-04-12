import { ConfigFilesDropdown } from "@web/components/elements/config-files-dropdown";
import { ConfigPage } from "@web/components/pages/config/config-page";
import { DashboardPage } from "@web/components/pages/dashboard/dashboard-page";
import { HistoryPage } from "@web/components/pages/history/history-page";
import { useIntl } from "@web/components/provider/intl-provider";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@web/components/ui/tabs";
import { LanguageToggle } from "@web/components/toggle/language-toggle";
import { ThemeToggle } from "@web/components/toggle/theme-toggle";
import { useUiStore, type MainTab } from "@web/store/ui-store";

/**
 * App-level shell: title + main tab bar + global config dropdown. Each tab
 * renders its own page component; configuration shares state via the
 * zustand ui-store so switching tabs never loses the selected config.
 */
export function AppShell() {
  const { t } = useIntl();
  const mainTab = useUiStore((s) => s.mainTab);
  const setMainTab = useUiStore((s) => s.setMainTab);

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">
            {t("APP.TITLE")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t("APP.SUBTITLE")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>
      <Tabs
        value={mainTab}
        onValueChange={(value) => {
          if (typeof value === "string") setMainTab(value as MainTab);
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <TabsList>
            <TabsTrigger value="dashboard">
              {t("TABS.DASHBOARD")}
            </TabsTrigger>
            <TabsTrigger value="config">
              {t("TABS.CONFIGURATION")}
            </TabsTrigger>
            <TabsTrigger value="history">
              {t("TABS.HISTORY")}
            </TabsTrigger>
          </TabsList>
          <ConfigFilesDropdown />
        </div>
        <TabsContent value="dashboard" className="mt-6">
          <DashboardPage />
        </TabsContent>
        <TabsContent value="config" className="mt-6">
          <ConfigPage />
        </TabsContent>
        <TabsContent value="history" className="mt-6">
          <HistoryPage />
        </TabsContent>
      </Tabs>
    </main>
  );
}
