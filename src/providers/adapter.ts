import type { RuntimeConfig } from "@/config/schema";
import type { ProviderReport, SyncState } from "@/lib/types";

export interface AdapterContext {
  config: RuntimeConfig;
  state: SyncState;
}

export interface ProviderAdapter {
  name: string;
  type: "newapi" | "direct" | "sub2api";
  discover(): Promise<void>;
  test(): Promise<void>;
  materialize(): Promise<ProviderReport>;
}
