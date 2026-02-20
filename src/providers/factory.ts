import type { RuntimeConfig } from "@/config";
import type {
  DirectProviderConfig,
  ProviderConfig,
  ProviderReport,
  Sub2ApiProviderConfig,
  SyncState
} from "@/lib/types";
import { processDirectProvider } from "@/providers/direct/provider";
import { processNewApiProvider } from "@/providers/newapi/provider";
import { processSub2ApiProvider } from "@/providers/sub2api/provider";

export interface ProviderAdapter {
  name: string;
  type: string;
  materialize(): Promise<ProviderReport>;
}

function providerOrder(
  type: RuntimeConfig["providers"][number]["type"]
): number {
  if (type === "newapi") return 0;
  if (type === "direct") return 1;
  return 2;
}

export function buildAdapters(
  config: RuntimeConfig,
  state: SyncState
): ProviderAdapter[] {
  return [...config.providers]
    .sort((a, b) => providerOrder(a.type) - providerOrder(b.type))
    .map((provider) => {
      if (provider.type === "newapi") {
        return {
          name: provider.name,
          type: provider.type,
          materialize: () =>
            processNewApiProvider(provider as ProviderConfig, config, state)
        };
      }
      if (provider.type === "direct") {
        return {
          name: provider.name,
          type: provider.type,
          materialize: () =>
            processDirectProvider(
              provider as DirectProviderConfig,
              config,
              state
            )
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
