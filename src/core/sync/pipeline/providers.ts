import type { RuntimeConfig } from "@core/config";
import {
  FLAT_VARIANT_SUFFIX,
  GRID_VARIANT_SUFFIX,
} from "@core/pricing/image-per-call";
import type { ProviderRunContext, UpstreamOffer } from "@core/pricing/offers";
import { throwIfRunAborted } from "@core/infra/abort";
import { timingTrack } from "@core/infra/timing";
import type { MergedGroup, ProviderReport } from "@core/types";
import type {
  NvidiaProviderConfig,
  OpenRouterProviderConfig,
  ProviderConfig,
  SimpleFreeProviderConfig,
  Sub2ApiProviderConfig,
  A7ApiProviderConfig,
} from "@core/validations/config";
import { processA7ApiProvider } from "@core/vendors/a7api/provider";
import { processNewApiProvider } from "@core/vendors/newapi/provider";
import { processNvidiaProvider } from "@core/vendors/nvidia/provider";
import { processOpenRouterProvider } from "@core/vendors/openrouter/provider";
import { processSub2ApiProvider } from "@core/vendors/sub2api/provider";
import {
  SIMPLE_PROVIDER_MAP,
  processSimpleProvider,
} from "@core/vendors/registry";

// new-api bills ONE billing type per model NAME. The SAME media model is served per-token
// (quota_type 0: ratio+completionRatio, HONORS size/quality params) by some relays and per-call flat
// (model_price, IGNORES params) by others. Where BOTH exist for one exposed name, publish the per-call
// occurrences under a `:flat` suffix so they don't collide with the per-token (params) base. A model
// that is per-call on EVERY provider (no per-token sibling) keeps its clean base name (no redundant
// `:flat` twin). Cross-provider, so it runs once after all offers are collected. Mutates in place.
function applyFlatVariantSplit(offers: UpstreamOffer[]): void {
  const perToken = new Set<string>();
  const perCall = new Set<string>();
  for (const offer of offers)
    for (const m of offer.models) {
      if (m.modelType === "text" || m.isFree) continue;
      const fixed =
        (m.modelPrice !== undefined && m.modelPrice > 0) ||
        (m.quotaType !== undefined && m.quotaType >= 1);
      (fixed ? perCall : perToken).add(m.exposed);
    }
  // Only names that are BOTH per-token somewhere AND per-call somewhere need the split.
  const split = new Set([...perCall].filter((n) => perToken.has(n)));
  if (split.size === 0) return;
  for (const offer of offers)
    for (const m of offer.models) {
      if (!split.has(m.exposed)) continue;
      const fixed =
        (m.modelPrice !== undefined && m.modelPrice > 0) ||
        (m.quotaType !== undefined && m.quotaType >= 1);
      if (fixed && !m.exposed.endsWith(FLAT_VARIANT_SUFFIX))
        m.exposed = `${m.exposed}${FLAT_VARIANT_SUFFIX}`;
    }
}

// A resolution grid (quotaType 4, ModelGridPricing) is a distinct billing type: on a shared name the
// grid deletes the base's per-token ratios (option-maps grid branch). Always publish grid occurrences
// under `:grid` so a per-token/per-call twin keeps its own name and the grid never cannibalizes it.
// Runs after applyFlatVariantSplit; mutates OfferModel.exposed in place.
function applyGridVariantSplit(offers: UpstreamOffer[]): void {
  for (const offer of offers)
    for (const m of offer.models)
      if (m.gridRows?.length && !m.exposed.endsWith(GRID_VARIANT_SUFFIX))
        m.exposed = `${m.exposed}${GRID_VARIANT_SUFFIX}`;
}

// Bespoke providers get explicit ordering; simple registry providers slot in the
// middle. sub2api runs last (depends on nothing but is cheapest to retry).
const BESPOKE_ORDER: Record<string, number> = {
  newapi: 0,
  nvidia: 1,
  openrouter: 2,
  a7api: 3,
  sub2api: 100,
};
function typeOrder(type: string): number {
  return BESPOKE_ORDER[type] ?? 50;
}

export async function runAllProviders(
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): Promise<{
  reports: ProviderReport[];
  offers: UpstreamOffer[];
  extraGroups: MergedGroup[];
  originalEndpointsByName: Map<string, string[]>;
  normalizedEndpointsByName: Map<string, string[]>;
  aggregatedEndpointPaths: Map<string, { path: string; method: string }>;
}> {
  // comfyui + aihorde + runware build channels separately; private providers are
  // declarative-only (no discovery/testing/pricing) and handled in the pipeline.
  const pricingProviders = config.providers.filter(
    (p) => p.type !== "comfyui" && p.type !== "aihorde" && p.type !== "runware",
  );
  const sorted = [...pricingProviders].sort(
    (a, b) => typeOrder(a.type) - typeOrder(b.type),
  );

  const settled = await Promise.all(
    sorted.map((provider) =>
      timingTrack(`provider:${provider.name}`, async () => {
        throwIfRunAborted();
        if (provider.type === "newapi")
          return processNewApiProvider(provider as ProviderConfig, config, ctx);
        if (provider.type === "a7api")
          return processA7ApiProvider(
            provider as A7ApiProviderConfig,
            config,
            ctx,
          );
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
    ),
  );

  const reports: ProviderReport[] = [];
  const offers: UpstreamOffer[] = [];
  const extraGroups: MergedGroup[] = [];
  const aggregatedEndpointPaths = new Map<
    string,
    { path: string; method: string }
  >();
  const originalEndpointsByName = new Map<string, string[]>();
  const normalizedEndpointsByName = new Map<string, string[]>();

  for (const result of settled) {
    reports.push(result.report);
    offers.push(...result.offers);
    if (result.extraGroups) extraGroups.push(...result.extraGroups);
    for (const [k, v] of result.endpointMetadata.endpointPaths)
      aggregatedEndpointPaths.set(k, v);
  }

  applyFlatVariantSplit(offers);
  applyGridVariantSplit(offers);

  for (const result of settled) {
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
    extraGroups,
    originalEndpointsByName,
    normalizedEndpointsByName,
    aggregatedEndpointPaths,
  };
}
