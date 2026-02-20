import type { RuntimeConfig } from "@/config";
import type {
  ProviderConfig,
  ProviderReport,
  Sub2ApiProviderConfig,
  SyncState
} from "@/lib/types";
import { processNewApiProvider } from "@/providers/newapi/provider";
import { processSub2ApiProvider } from "@/providers/sub2api/provider";

export interface ProviderAdapter {
  name: string;
  type: string;
  materialize(): Promise<ProviderReport>;
}

export function buildAdapters(
  config: RuntimeConfig,
  state: SyncState
): ProviderAdapter[] {
  return [...config.providers]
    .sort((a, b) => (a.type === "newapi" ? -1 : 0) - (b.type === "newapi" ? -1 : 0))
    .map((provider) => {
      if (provider.type === "newapi") {
        return {
          name: provider.name,
          type: provider.type,
          materialize: () =>
            processNewApiProvider(provider as ProviderConfig, config, state)
        };
      }
      return {
        name: provider.name,
        type: provider.type,
        materialize: () =>
          processSub2ApiProvider(
            provider as Sub2ApiProviderConfig,
            config,
            state
          )
      };
    });
}
