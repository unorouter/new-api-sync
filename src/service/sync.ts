import type {
  Config,
  DirectProviderConfig,
  ProviderConfig,
  Sub2ApiProviderConfig,
  SyncReport,
  SyncState,
} from "@/lib/types";
import { processDirectProvider } from "@/providers/direct/provider";
import { processNewApiProvider } from "@/providers/newapi/provider";
import { processSub2ApiProvider } from "@/providers/sub2api/provider";
import { consola } from "consola";
import { syncToTarget } from "./target-sync";

export class SyncService {
  private state: SyncState = {
    mergedGroups: [],
    mergedModels: new Map(),
    modelEndpoints: new Map(),
    channelsToCreate: [],
  };

  constructor(private config: Config) {}

  async sync(): Promise<SyncReport> {
    const startTime = Date.now();

    const report: SyncReport = {
      success: true,
      providers: [],
      channels: { created: 0, updated: 0, deleted: 0 },
      options: { updated: [] },
      errors: [],
      timestamp: new Date(),
    };

    // Process newapi first, then direct, then sub2api last (undercuts prices)
    const newapiProviders = this.config.providers.filter((p) => p.type !== "sub2api" && p.type !== "direct");
    const directProviders = this.config.providers.filter((p) => p.type === "direct");
    const sub2apiProviders = this.config.providers.filter((p) => p.type === "sub2api");

    for (const providerConfig of newapiProviders) {
      const providerReport = await processNewApiProvider(
        providerConfig as ProviderConfig,
        this.config,
        this.state,
      );
      report.providers.push(providerReport);
    }

    for (const providerConfig of directProviders) {
      const providerReport = await processDirectProvider(
        providerConfig as DirectProviderConfig,
        this.config,
        this.state,
      );
      report.providers.push(providerReport);
    }

    // Process sub2api providers last — they undercut newapi prices from state
    for (const providerConfig of sub2apiProviders) {
      const providerReport = await processSub2ApiProvider(
        providerConfig as Sub2ApiProviderConfig,
        this.config,
        this.state,
      );
      report.providers.push(providerReport);
    }

    if (this.state.mergedGroups.length === 0 && this.config.providers.length > 0) {
      consola.error("No groups collected from any provider");
      report.success = false;
      report.errors.push({ phase: "collect", message: "No groups collected" });
      return report;
    }

    // Sync to target
    const { modelsCreated, modelsUpdated, modelsDeleted, orphansDeleted } =
      await syncToTarget(this.config, this.state, report);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    report.success = report.errors.length === 0;

    const orphanStr = orphansDeleted > 0 ? ` | Orphans: -${orphansDeleted}` : "";
    consola.success(
      `Done in ${elapsed}s | Providers: ${report.providers.filter((p) => p.success).length}/${report.providers.length} | Channels: +${report.channels.created} ~${report.channels.updated} -${report.channels.deleted} | Models: +${modelsCreated} ~${modelsUpdated} -${modelsDeleted}${orphanStr}`,
    );

    // Log failed providers (non-fatal)
    const failedProviders = report.providers.filter((p) => !p.success);
    for (const p of failedProviders) {
      consola.warn(`[${p.name}] ${p.error}`);
    }

    // Log fatal errors
    if (report.errors.length > 0) {
      for (const err of report.errors) {
        consola.error(`[${err.provider ?? "target"}/${err.phase}] ${err.message}`);
      }
    }

    return report;
  }
}
