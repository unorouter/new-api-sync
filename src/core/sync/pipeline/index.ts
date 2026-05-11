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

export async function runProviderPipeline(
  config: RuntimeConfig,
  targetSnapshot?: TargetSnapshot,
): Promise<{ desired: DesiredState; providerReports: ProviderReport[] }> {
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

  const { mergedGroups, mergedModels, channels } = emitChannels({
    plan,
    baseline,
  });

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

  const allPricingGrids: Record<string, Record<string, string | number>[]> = {};
  const allMetadata: Record<string, Record<string, unknown>> = {};
  for (const provider of config.providers) {
    Object.assign(
      allPricingGrids,
      getPricingGridFromEnabledModels(provider.enabledModels),
    );
    Object.assign(
      allMetadata,
      getMetadataFromEnabledModels(provider.enabledModels),
    );
  }

  const optionMaps = buildOptionMaps(
    mergedGroups,
    mergedModels,
    config.modelMapping,
    allPricingGrids,
  );

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
        ...config.providers.map((p) => p.name),
        ...(targetSnapshot && !config.onlyProviders
          ? targetSnapshot.channels.filter((ch) => ch.tag).map((ch) => ch.tag!)
          : []),
      ]),
      mappingSources: new Set(Object.keys(config.modelMapping)),
    },
  };
}
