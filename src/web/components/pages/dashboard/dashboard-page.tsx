import { HealthPanel } from "./health-panel";
import { SyncPanel } from "./sync-panel";

export function DashboardPage() {
  return (
    <div className="grid gap-4">
      <HealthPanel />
      <SyncPanel />
    </div>
  );
}
