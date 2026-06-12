import type { RuntimeConfig } from "@core/config";
import type { UpstreamOffer } from "@core/pricing/offers";
import type { PricingSource } from "@core/pricing/resolver";
import { throwIfRunAborted } from "@core/infra/abort";
import type { ProviderReport } from "@core/types";
import type {
  NvidiaProviderConfig,
  OpenRouterProviderConfig,
  ProviderConfig,
  SimpleFreeProviderConfig,
  Sub2ApiProviderConfig,
} from "@core/validations/config";
import { processNewApiProvider } from "@core/vendors/newapi/provider";
import { processNvidiaProvider } from "@core/vendors/nvidia/provider";
import { processOpenRouterProvider } from "@core/vendors/openrouter/provider";
import { processSub2ApiProvider } from "@core/vendors/sub2api/provider";
import {
  SIMPLE_PROVIDER_MAP,
  processSimpleProvider,
} from "@core/vendors/registry";

// Bespoke providers get explicit ordering; simple registry providers slot in the
// middle. sub2api runs last (depends on nothing but is cheapest to retry).
const BESPOKE_ORDER: Record<string, number> = {
  newapi: 0,
  nvidia: 1,
  openrouter: 2,
  sub2api: 100,
};
function typeOrder(type: string): number {
  return BESPOKE_ORDER[type] ?? 50;
}

export async function runAllProviders(
  config: RuntimeConfig,
  ctx: { pricingSources: PricingSource[]; reverseMapping: Map<string, string> },
): Promise<{
  reports: ProviderReport[];
  offers: UpstreamOffer[];
  originalEndpointsByName: Map<string, string[]>;
  normalizedEndpointsByName: Map<string, string[]>;
  aggregatedEndpointPaths: Map<string, { path: string; method: string }>;
}> {
  // comfyui builds channels separately; private providers are declarative-only
  // (no discovery/testing/pricing) and handled in the pipeline.
  const pricingProviders = config.providers.filter(
    (p) => p.type !== "comfyui" && p.type !== "private",
  );
  const sorted = [...pricingProviders].sort(
    (a, b) => typeOrder(a.type) - typeOrder(b.type),
  );

  const settled = await Promise.all(
    sorted.map((provider) => {
      throwIfRunAborted();
      if (provider.type === "newapi")
        return processNewApiProvider(provider as ProviderConfig, config, ctx);
      if (provider.type === "nvidia")
        return processNvidiaProvider(
          provider as NvidiaProviderConfig,
          config,
          ctx,
        );
      if (provider.type === "openrouter")
        return processOpenRouterProvider(
          provider as OpenRouterProviderConfig,
          config,
          ctx,
        );
      if (provider.type === "sub2api")
        return processSub2ApiProvider(
          provider as Sub2ApiProviderConfig,
          config,
          ctx,
        );
      const def = SIMPLE_PROVIDER_MAP[provider.type];
      if (def)
        return processSimpleProvider(
          def,
          provider as SimpleFreeProviderConfig,
          config,
          ctx,
        );
      throw new Error(`unknown provider type: ${provider.type}`);
    }),
  );

  const reports: ProviderReport[] = [];
  const offers: UpstreamOffer[] = [];
  const aggregatedEndpointPaths = new Map<
    string,
    { path: string; method: string }
  >();
  const originalEndpointsByName = new Map<string, string[]>();
  const normalizedEndpointsByName = new Map<string, string[]>();

  for (const result of settled) {
    reports.push(result.report);
    offers.push(...result.offers);
    for (const [k, v] of result.endpointMetadata.endpointPaths)
      aggregatedEndpointPaths.set(k, v);
    for (const offer of result.offers) {
      for (const m of offer.models) {
        if (m.endpoints?.length) {
          originalEndpointsByName.set(m.exposed, m.endpoints);
          originalEndpointsByName.set(m.upstream, m.endpoints);
        }
        if (m.normalizedEndpoints?.length) {
          normalizedEndpointsByName.set(m.exposed, m.normalizedEndpoints);
          normalizedEndpointsByName.set(m.upstream, m.normalizedEndpoints);
        }
      }
    }
  }

  return {
    reports,
    offers,
    originalEndpointsByName,
    normalizedEndpointsByName,
    aggregatedEndpointPaths,
  };
}
