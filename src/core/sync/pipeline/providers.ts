import type { RuntimeConfig } from "@core/config";
import type { UpstreamOffer } from "@core/pricing/offers";
import { processNewApiProvider } from "@core/vendors/newapi/provider";
import { processNvidiaProvider } from "@core/vendors/nvidia/provider";
import { processOpenRouterProvider } from "@core/vendors/openrouter/provider";
import { processSub2ApiProvider } from "@core/vendors/sub2api/provider";
import { throwIfRunAborted } from "@core/runtime";
import type { ProviderReport } from "@core/types";
import type {
  NvidiaProviderConfig,
  OpenRouterProviderConfig,
  ProviderConfig,
  Sub2ApiProviderConfig,
} from "@core/validations/config";

const TYPE_ORDER: Record<string, number> = {
  newapi: 0,
  nvidia: 1,
  openrouter: 2,
  sub2api: 3,
};

/**
 * Run every provider in the config concurrently and aggregate their results.
 *
 * Providers are sorted by type before dispatch so the returned reports stay
 * in deterministic order regardless of completion order. Per-upstream
 * concurrency is bounded by the shared ConcurrencyGate (initialised by the
 * orchestrator), so opening up the structural Promise.all is safe.
 *
 * Returns:
 * - reports / offers — one per provider
 * - originalEndpointsByName / normalizedEndpointsByName — exposed AND
 *   upstream model names mapped to their endpoint hints (used by
 *   buildDesiredModels and collectResponsesApiModels)
 * - aggregatedEndpointPaths — endpoint type -> {path, method}, last-write
 *   wins on collision (matches pre-refactor behaviour)
 */
export async function runAllProviders(config: RuntimeConfig): Promise<{
  reports: ProviderReport[];
  offers: UpstreamOffer[];
  originalEndpointsByName: Map<string, string[]>;
  normalizedEndpointsByName: Map<string, string[]>;
  aggregatedEndpointPaths: Map<string, { path: string; method: string }>;
}> {
  const sorted = [...config.providers].sort(
    (a, b) => (TYPE_ORDER[a.type] ?? 2) - (TYPE_ORDER[b.type] ?? 2),
  );

  const settled = await Promise.all(
    sorted.map((provider) => {
      throwIfRunAborted();
      if (provider.type === "newapi") {
        return processNewApiProvider(provider as ProviderConfig, config);
      }
      if (provider.type === "nvidia") {
        return processNvidiaProvider(provider as NvidiaProviderConfig, config);
      }
      if (provider.type === "openrouter") {
        return processOpenRouterProvider(
          provider as OpenRouterProviderConfig,
          config,
        );
      }
      return processSub2ApiProvider(provider as Sub2ApiProviderConfig, config);
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
    for (const [k, v] of result.endpointMetadata.endpointPaths) {
      aggregatedEndpointPaths.set(k, v);
    }
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
