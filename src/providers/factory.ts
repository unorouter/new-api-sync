import type { RuntimeConfig } from "@/config/schema";
import type {
  DirectProviderConfig,
  ProviderConfig,
  Sub2ApiProviderConfig,
} from "@/lib/types";
import type { AdapterContext, ProviderAdapter } from "@/providers/adapter";
import { DirectProviderAdapter } from "@/providers/direct/adapter";
import { NewApiProviderAdapter } from "@/providers/newapi/adapter";
import { Sub2ApiProviderAdapter } from "@/providers/sub2api/adapter";

function providerOrder(type: RuntimeConfig["providers"][number]["type"]): number {
  if (type === "newapi") return 0;
  if (type === "direct") return 1;
  return 2;
}

export function buildAdapters(
  config: RuntimeConfig,
  context: AdapterContext,
): ProviderAdapter[] {
  return [...config.providers]
    .sort((a, b) => providerOrder(a.type) - providerOrder(b.type))
    .map((provider) => {
      if (provider.type === "newapi") {
        return new NewApiProviderAdapter(
          provider.name,
          provider as ProviderConfig,
          context,
        );
      }
      if (provider.type === "direct") {
        return new DirectProviderAdapter(
          provider.name,
          provider as DirectProviderConfig,
          context,
        );
      }
      return new Sub2ApiProviderAdapter(
        provider.name,
        provider as Sub2ApiProviderConfig,
        context,
      );
    });
}
