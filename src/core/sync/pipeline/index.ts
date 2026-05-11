import { buildReverseMapping } from "@core/catalog/constants/patterns";
import {
  fetchBasellmEntries,
  fetchOpenRouterDescriptions,
} from "@core/catalog/metadata";
import {
  getMetadataFromEnabledModels,
  getPricingGridFromEnabledModels,
  type RuntimeConfig,
} from "@core/config";
import { computePricedPlan } from "@core/pricing/compute";
import { emitChannels } from "@core/pricing/emit";
import { fetchAllPricingSources } from "@core/pricing/resolver";
import { ConcurrencyGate, setConcurrencyGate } from "@core/infra/concurrency";
import type { DesiredState, ProviderReport, TargetSnapshot } from "@core/types";
import type { ComfyUiProviderConfig } from "@core/validations/config";
import { buildComfyUiChannels } from "@core/vendors/comfyui/provider";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildBaseline } from "./baseline";
import { resolveCanonicalRetail } from "./canonical";
import {
  buildDesiredModels,
  collectResponsesApiModels,
} from "./desired-models";
import { buildOptionMaps } from "./option-maps";
import { runAllProviders } from "./providers";

// Pricing math (canonical override, rescale, cap drops, free clobber-skip,
// OpenRouter paid bucketing, sub2api cheapest-existing lookup) lives
// in src/core/pricing/compute.ts. The orchestration below collects offers
// from each provider, resolves canonical retail ratios up front, then calls
// computePricedPlan + emitChannels to produce the final state.
export async function runProviderPipeline(
  config: RuntimeConfig,
  targetSnapshot?: TargetSnapshot,
): Promise<{ desired: DesiredState; providerReports: ProviderReport[] }> {
  // Initialise the shared concurrency gate. Per-upstream overrides are keyed
  // by baseUrl so testModels / probe code can look them up without knowing
  // the provider name.
  const overrides = new Map<string, number>();
  for (const p of config.providers) {
    if ("baseUrl" in p && p.baseUrl && p.perUpstreamConcurrency) {
      overrides.set(p.baseUrl, p.perUpstreamConcurrency);
    }
  }
  setConcurrencyGate(
    new ConcurrencyGate({
      globalLimit: config.globalConcurrency,
      perUpstreamLimit: config.perUpstreamConcurrency,
      overrides,
    }),
  );

  const managedProviders = new Set(config.providers.map((p) => p.name));
  const baseline = await buildBaseline({
    config,
    targetSnapshot,
    managedProviders,
  });

  // Fetch metadata + pricing sources up front. Used for canonical retail
  // resolution AND for description/tags enrichment in buildDesiredModels.
  const [basellmEntries, openRouterDescriptions] = await Promise.all([
    fetchBasellmEntries(),
    fetchOpenRouterDescriptions(),
  ]);
  const pricingSources = await fetchAllPricingSources(basellmEntries);
  const reverseMapping = buildReverseMapping(config.modelMapping);

  const {
    reports: providerReports,
    offers: allOffers,
    originalEndpointsByName,
    normalizedEndpointsByName,
    aggregatedEndpointPaths,
  } = await runAllProviders(config, { pricingSources, reverseMapping });

  const canonical = resolveCanonicalRetail({
    allOffers,
    baseline,
    pricingSources,
    reverseMapping,
  });

  // Compute the priced plan and emit it as concrete state.
  const plan = computePricedPlan({
    offers: allOffers,
    baseline,
    canonical,
    pricingSources,
    reverseMapping,
    modelMapping: config.modelMapping,
  });

  for (const drop of plan.drops) {
    consola.info(
      t("CORE.PRICING.DROP", {
        model: drop.model,
        channel: drop.channel,
        reason: drop.reason,
        detail: drop.detail ? ` ${drop.detail}` : "",
      }),
    );
  }

  const emitted = emitChannels({ plan, baseline });
  const mergedGroups = emitted.mergedGroups;
  const mergedModels = emitted.mergedModels;
  const channels = emitted.channels;

  // Append ComfyUI channels: hand-defined, no upstream discovery, no pricing
  // pipeline. Each comfyui provider yields exactly one channel that carries
  // the workflow_templates JSON the new-api adapter parses at request time.
  // We also register the channel's group in mergedGroups so option-maps adds
  // it to UserUsableGroups/AutoGroups/GroupRatio — without this, the comfyui
  // models exist in the DB but the pricing UI filters them out (every model
  // is gated by enable_groups intersecting the user's usable groups).
  for (const provider of config.providers) {
    if (provider.type !== "comfyui") continue;
    const result = buildComfyUiChannels(provider as ComfyUiProviderConfig);
    providerReports.push(result.report);
    if (!result.report.success) {
      consola.warn(
        `comfyui provider ${provider.name} failed: ${result.report.error ?? ""}`,
      );
      continue;
    }
    channels.push(...result.channels);
    for (const channel of result.channels) {
      mergedGroups.push({
        name: channel.group,
        ratio: 1,
        description: `ComfyUI via ${provider.name}`,
        provider: channel.tag ?? provider.name,
      });
    }
  }

  // Collect pricing grid data from all providers' enabledModels
  const allPricingGrids: Record<string, Record<string, string | number>[]> = {};
  for (const provider of config.providers) {
    const grids = getPricingGridFromEnabledModels(provider.enabledModels);
    Object.assign(allPricingGrids, grids);
  }

  // Collect per-model metadata overrides from all providers' enabledModels.
  const allMetadata: Record<string, Record<string, unknown>> = {};
  for (const provider of config.providers) {
    const metadata = getMetadataFromEnabledModels(provider.enabledModels);
    Object.assign(allMetadata, metadata);
  }

  const optionMaps = buildOptionMaps(
    mergedGroups,
    mergedModels,
    config.modelMapping,
    allPricingGrids,
  );

  // Push per-template ComfyUI prices into the ModelPrice option map. ComfyUI
  // bypasses the pricing pipeline (no upstream catalog), so the operator
  // declares per-call USD prices in config.yml under each template's `price`
  // field. quotaType=1 marks them as per-request billing.
  for (const provider of config.providers) {
    if (provider.type !== "comfyui") continue;
    const cfg = provider as ComfyUiProviderConfig;
    for (const [modelName, tpl] of Object.entries(cfg.templates)) {
      const mapped = config.modelMapping?.[modelName] ?? modelName;
      optionMaps.modelPrice[mapped] = Math.round(tpl.price * 10000) / 10000;
      optionMaps.modelQuotaType[mapped] = 1;
    }
  }

  const models = buildDesiredModels({
    channels,
    originalEndpointsByName,
    normalizedEndpointsByName,
    endpointPaths: aggregatedEndpointPaths,
    reverseMapping,
    basellmEntries,
    openRouterDescriptions,
    modelMapping: config.modelMapping,
    metadataByUpstream: allMetadata,
    pricingSources,
  });

  const responsesApiModels = collectResponsesApiModels(
    channels,
    normalizedEndpointsByName,
    reverseMapping,
    config.modelMapping,
  );

  return {
    providerReports,
    desired: {
      channels,
      models,
      options: {
        ...optionMaps,
        defaultUseAutoGroup: true,
        responsesApiModels: [...new Set(responsesApiModels)],
      },
      managedProviders: new Set([
        ...config.providers.map((provider) => provider.name),
        // During full syncs, also claim ownership of channels tagged by
        // providers that were previously synced but are no longer in config,
        // so their channels/models get cleaned up.
        ...(targetSnapshot && !config.onlyProviders
          ? targetSnapshot.channels.filter((ch) => ch.tag).map((ch) => ch.tag!)
          : []),
      ]),
      mappingSources: new Set(Object.keys(config.modelMapping)),
    },
  };
}
