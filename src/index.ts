/**
 * proxy-sync - Declarative multi-provider sync for new-api
 */

export { sync } from "@/sync";
export { loadConfig, validateConfig } from "@/lib/config";
export { UpstreamClient } from "@/clients/upstream-client";
export { TargetClient } from "@/clients/target-client";

export type {
  Config,
  TargetConfig,
  ProviderConfig,
  SyncOptions,
  SyncReport,
  ProviderReport,
  SyncError,
  Channel,
  GroupInfo,
  ModelInfo,
  UpstreamPricing,
  UpstreamToken,
} from "@/types";
