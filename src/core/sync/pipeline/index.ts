import {
  buildReverseMapping,
  parseModelList,
} from "@core/catalog/constants/patterns";
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
import type {
  DesiredState,
  ManagedOptionMaps,
  ProviderReport,
  TargetSnapshot,
} from "@core/types";
import type {
  AIHordeProviderConfig,
  RunwareProviderConfig,
  ComfyUiProviderConfig,
} from "@core/validations/config";
import { buildAIHordeChannels } from "@core/vendors/aihorde-image/provider";
import { buildRunwareChannels } from "@core/vendors/runware-image/provider";
import { buildComfyUiChannels } from "@core/vendors/comfyui/provider";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildBaseline } from "./baseline";
import { resolveCanonicalRetail } from "./canonical";
import {
  buildDesiredModels,
  collectResponsesApiModels,
  isRoutingOnlyAlias,
  type ToolEvidence,
} from "./desired-models";
import { buildOptionMaps, buildSurvivingGroups } from "./option-maps";
import { runAllProviders } from "./providers";
import { timingMark } from "@core/infra/timing";

interface SnapshotPricing {
  modelRatio: Record<string, number>;
  modelPrice: Record<string, number>;
  completionRatio: Record<string, number>;
  modelQuotaType: Record<string, number>;
  billingExpr: Record<string, string>;
  billingMode: Record<string, string>;
}

function parseSnapshotPricing(snapshot?: TargetSnapshot): SnapshotPricing {
  const empty: SnapshotPricing = {
    modelRatio: {},
    modelPrice: {},
    completionRatio: {},
    modelQuotaType: {},
    billingExpr: {},
    billingMode: {},
  };
  if (!snapshot) return empty;
  const parse = <T>(key: string): Record<string, T> => {
    try {
      const raw = snapshot.options[key];
      return raw ? (JSON.parse(raw) as Record<string, T>) : {};
    } catch {
      return {};
    }
  };
  return {
    modelRatio: parse<number>("ModelRatio"),
    modelPrice: parse<number>("ModelPrice"),
    completionRatio: parse<number>("CompletionRatio"),
    modelQuotaType: parse<number>("ModelQuotaType"),
    billingExpr: parse<string>("billing_setting.billing_expr"),
    billingMode: parse<string>("billing_setting.billing_mode"),
  };
}

// Restore a paid price the target already holds for an unpriced published model.
// Returns true if anything was restored, so the caller skips the free default.
// Only a PAID existing entry (ratio > 0, price > 0, or a tiered expr) restores;
// a stored ratio of 0 is a genuinely-free model and falls through to the default.
function restoreSnapshotPrice(
  modelName: string,
  optionMaps: Pick<
    ManagedOptionMaps,
    | "modelRatio"
    | "modelPrice"
    | "completionRatio"
    | "modelQuotaType"
    | "billingExpr"
    | "billingMode"
  >,
  snap: SnapshotPricing,
): boolean {
  const expr = snap.billingExpr[modelName];
  if (expr !== undefined && expr.trim() !== "") {
    optionMaps.billingExpr[modelName] = expr;
    if (snap.billingMode[modelName] !== undefined)
      optionMaps.billingMode[modelName] = snap.billingMode[modelName]!;
    if (snap.completionRatio[modelName] !== undefined)
      optionMaps.completionRatio[modelName] = snap.completionRatio[modelName]!;
    return true;
  }
  const price = snap.modelPrice[modelName];
  if (price !== undefined && price > 0) {
    optionMaps.modelPrice[modelName] = price;
    if (snap.modelQuotaType[modelName] !== undefined)
      optionMaps.modelQuotaType[modelName] = snap.modelQuotaType[modelName]!;
    return true;
  }
  const ratio = snap.modelRatio[modelName];
  if (ratio !== undefined && ratio > 0) {
    optionMaps.modelRatio[modelName] = ratio;
    optionMaps.completionRatio[modelName] =
      snap.completionRatio[modelName] ?? 1;
    return true;
  }
  return false;
}

// Only a provider that actually reported its catalog may have channels deleted.
// A failed discovery yields zero offers, which the diff cannot tell apart from
// "serves nothing", so a transient stall would delete every lane the provider
// owns: a 10s logfare response against a 15s timeout wiped all 15 of its
// channels, 5 of them healthy and serving.
function buildManagedProviders(
  config: RuntimeConfig,
  reports: ProviderReport[],
  targetSnapshot?: TargetSnapshot,
): Set<string> {
  const failed = new Set(reports.filter((r) => !r.success).map((r) => r.name));
  const managed = new Set(
    config.providers.map((p) => p.name).filter((n) => !failed.has(n)),
  );
  if (targetSnapshot && !config.onlyProviders) {
    for (const channel of targetSnapshot.channels) {
      if (channel.tag && !failed.has(channel.tag)) managed.add(channel.tag);
    }
  }
  return managed;
}

export async function runProviderPipeline(
  config: RuntimeConfig,
  targetSnapshot?: TargetSnapshot,
  opts?: { dryRun?: boolean },
): Promise<{ desired: DesiredState; providerReports: ProviderReport[] }> {
  const overrides = new Map<string, number>();
  const autoTestIntervalByProvider = new Map<string, number>();
  const autoTestIntervalMaxByProvider = new Map<string, number>();
  const headerOverrideByProvider = new Map<string, string>();
  const forceUpstreamStreamByProvider = new Map<
    string,
    boolean | Record<string, boolean>
  >();
  for (const p of config.providers) {
    if ("baseUrl" in p && p.baseUrl && p.perUpstreamConcurrency)
      overrides.set(p.baseUrl, p.perUpstreamConcurrency);
    if ("autoTestIntervalMinutes" in p && p.autoTestIntervalMinutes)
      autoTestIntervalByProvider.set(p.name, p.autoTestIntervalMinutes);
    if ("autoTestIntervalMaxMinutes" in p && p.autoTestIntervalMaxMinutes)
      autoTestIntervalMaxByProvider.set(p.name, p.autoTestIntervalMaxMinutes);
    if (
      "headerOverride" in p &&
      p.headerOverride &&
      Object.keys(p.headerOverride).length > 0
    )
      headerOverrideByProvider.set(p.name, JSON.stringify(p.headerOverride));
    if ("forceUpstreamStream" in p && p.forceUpstreamStream !== undefined)
      forceUpstreamStreamByProvider.set(p.name, p.forceUpstreamStream);
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
  timingMark("pricing-sources");
  const reverseMapping = buildReverseMapping(config.modelMapping);

  const {
    reports: providerReports,
    offers: allOffers,
    extraGroups,
    originalEndpointsByName,
    normalizedEndpointsByName,
    aggregatedEndpointPaths,
  } = await runAllProviders(config, {
    pricingSources,
    reverseMapping,
    dryRun: opts?.dryRun,
    liveChannels: targetSnapshot?.channels,
  });

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
    modelAlias: config.modelAlias,
    systemPrompt: config.systemPrompt,
    autoTestIntervalByProvider,
    forceUpstreamStreamByProvider,
    autoTestIntervalMaxByProvider,
    headerOverrideByProvider,
  });

  for (const drop of plan.drops)
    consola.info(
      t("CORE.PRICING.DROP", {
        model: drop.model,
        channel: drop.channel,
        reason: drop.reason,
        detail: drop.detail ? ` ${drop.detail}` : "",
      }),
    );

  const { mergedGroups, mergedModels, channels } = emitChannels({
    plan,
    baseline,
  });
  // A live lane the run did not re-select keeps serving at its old ratio, and
  // cheapest-first routing would prefer it over the repriced ones.
  const emittedGroups = new Set(mergedGroups.map((g) => g.name));
  for (const g of extraGroups)
    if (!emittedGroups.has(g.name)) mergedGroups.push(g);

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
    for (const channel of result.channels)
      mergedGroups.push({
        name: channel.group,
        ratio: 1,
        description: `ComfyUI via ${provider.name}`,
        provider: channel.tag ?? provider.name,
      });
  }

  for (const provider of config.providers) {
    if (provider.type !== "aihorde") continue;
    const result = buildAIHordeChannels(provider as AIHordeProviderConfig);
    providerReports.push(result.report);
    if (!result.report.success) {
      consola.warn(
        `aihorde provider ${provider.name} failed: ${result.report.error ?? ""}`,
      );
      continue;
    }
    channels.push(...result.channels);
    for (const channel of result.channels)
      mergedGroups.push({
        name: channel.group,
        ratio: 1,
        description: `AI Horde via ${provider.name}`,
        provider: channel.tag ?? provider.name,
      });
  }

  for (const provider of config.providers) {
    if (provider.type !== "runware") continue;
    const result = buildRunwareChannels(provider as RunwareProviderConfig);
    providerReports.push(result.report);
    if (!result.report.success) {
      consola.warn(
        `runware provider ${provider.name} failed: ${result.report.error ?? ""}`,
      );
      continue;
    }
    channels.push(...result.channels);
    for (const channel of result.channels)
      mergedGroups.push({
        name: channel.group,
        ratio: 1,
        description: `Runware via ${provider.name}`,
        provider: channel.tag ?? provider.name,
      });
  }

  const allPricingGrids: Record<string, Record<string, string | number>[]> = {};
  const allMetadata: Record<string, Record<string, unknown>> = {};
  // Provider-decoded resolution grids (ephone image models priced per resolution). Keyed by the
  // PUBLISHED name (m.exposed) which applyGridVariantSplit renamed to `{name}:grid`, so the grid
  // attaches to the `:grid` variant and the bare name keeps its per-token/per-call billing.
  // Seeded first so config `modelPricingGrid` overrides win on key collision.
  for (const offer of allOffers)
    for (const m of offer.models)
      if (m.gridRows?.length) allPricingGrids[m.exposed] = m.gridRows;
  // Provider-supplied per-model metadata (e.g. Groq upstream max_completion_tokens).
  // Seeded first so config enabledModels overrides win on key collision.
  for (const offer of allOffers)
    for (const m of offer.models)
      if (m.metadata)
        allMetadata[m.upstream] = { ...allMetadata[m.upstream], ...m.metadata };
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
    config.rateLimit,
    targetSnapshot
      ? buildSurvivingGroups(targetSnapshot.channels, targetSnapshot.options)
      : undefined,
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

  for (const provider of config.providers) {
    if (provider.type !== "aihorde") continue;
    const cfg = provider as AIHordeProviderConfig;
    for (const [modelName, m] of Object.entries(cfg.models)) {
      const mapped = config.modelMapping?.[modelName] ?? modelName;
      optionMaps.modelPrice[mapped] = Math.round(m.price * 10000) / 10000;
      optionMaps.modelQuotaType[mapped] = 1;
    }
  }

  for (const provider of config.providers) {
    if (provider.type !== "runware") continue;
    const cfg = provider as RunwareProviderConfig;
    for (const [modelName, m] of Object.entries(cfg.models)) {
      const mapped = config.modelMapping?.[modelName] ?? modelName;
      optionMaps.modelPrice[mapped] = Math.round(m.price * 10000) / 10000;
      optionMaps.modelQuotaType[mapped] = 1;
    }
  }

  // Safety net: every model a channel publishes MUST carry a price, or new-api
  // 400s it ("not priced by administrator"). A model can reach a channel yet
  // miss the option maps (out-of-scope partial sync, half-applied modelMapping
  // collapse, a dropped pipeline stage). Key by the EXACT published name
  // (channel.models is already the post-mapping exposed name); new-api looks up
  // the price by the published name, so the price must live under that same key.
  //
  // An unpriced published name that is a modelMapping ALIAS (exposed -> upstream)
  // inherits its upstream target's price: the alias and target are the same model
  // (e.g. minimax-m2.5-highspeed -> minimax-m2.5), so shipping the alias free
  // while the target is paid leaks the model. Only a name with no priced target
  // falls back to free (ratio 0) -- the genuinely-free-gateway default.
  const snapshotPricing = parseSnapshotPricing(targetSnapshot);
  const restoredFromSnapshot: string[] = [];
  const defaultedFree: string[] = [];
  for (const channel of channels) {
    for (const modelName of parseModelList(channel.models)) {
      if (isRoutingOnlyAlias(modelName)) continue;
      if (
        optionMaps.modelRatio[modelName] !== undefined ||
        optionMaps.modelPrice[modelName] !== undefined ||
        optionMaps.billingExpr[modelName] !== undefined ||
        optionMaps.modelQuotaType[modelName] !== undefined
      )
        continue;
      const target = config.modelMapping?.[modelName];
      if (
        target &&
        target !== modelName &&
        (optionMaps.modelRatio[target] !== undefined ||
          optionMaps.modelPrice[target] !== undefined ||
          optionMaps.billingExpr[target] !== undefined ||
          optionMaps.modelQuotaType[target] !== undefined)
      ) {
        if (optionMaps.modelRatio[target] !== undefined)
          optionMaps.modelRatio[modelName] = optionMaps.modelRatio[target];
        if (optionMaps.modelPrice[target] !== undefined)
          optionMaps.modelPrice[modelName] = optionMaps.modelPrice[target];
        if (optionMaps.billingExpr[target] !== undefined)
          optionMaps.billingExpr[modelName] = optionMaps.billingExpr[target];
        if (optionMaps.modelQuotaType[target] !== undefined)
          optionMaps.modelQuotaType[modelName] =
            optionMaps.modelQuotaType[target];
        optionMaps.completionRatio[modelName] =
          optionMaps.completionRatio[target] ?? 1;
        continue;
      }
      // A model that already carries a PAID price in the target keeps it. A
      // pricing-less publisher (e.g. a private declarative channel serving a
      // paid model name) recomputes nothing this run; defaulting it to ratio 0
      // would clobber the live paid ratio with $0 (the gemini-3.1-pro-preview
      // partial-sync regression). Free defaults stay reserved for names with no
      // existing paid price anywhere.
      if (restoreSnapshotPrice(modelName, optionMaps, snapshotPricing)) {
        restoredFromSnapshot.push(modelName);
        continue;
      }
      optionMaps.modelRatio[modelName] = 0;
      optionMaps.completionRatio[modelName] = 1;
      defaultedFree.push(modelName);
    }
  }
  // Make the safety-net visible: "restored" means a published model carried no
  // price this run but kept its live PAID ratio (e.g. a private channel serving
  // a paid model). "defaulted free" means it shipped at ratio 0. Either line on a
  // model you expect to be paid is the gemini-3.1-pro-preview $0 regression.
  if (restoredFromSnapshot.length > 0)
    consola.info(
      `[safety-net] kept live paid price for ${restoredFromSnapshot.length} unpriced published model(s): ${restoredFromSnapshot.sort().join(", ")}`,
    );
  if (defaultedFree.length > 0)
    consola.warn(
      `[safety-net] defaulted ${defaultedFree.length} unpriced published model(s) to FREE (ratio 0): ${defaultedFree.sort().join(", ")}`,
    );

  // Per published name across every serving channel: any verified-true wins;
  // definitive-false only when no channel passed; transients (null) carry no vote.
  const toolEvidence = new Map<string, ToolEvidence>();
  for (const tier of plan.tiers) {
    for (const d of tier.testDetails ?? []) {
      if (d.toolCallSuccess === null) continue;
      for (const name of tier.models) {
        if (isRoutingOnlyAlias(name)) continue;
        const cur = toolEvidence.get(name) ?? {
          supportsTools: false,
          supportsParallelTools: false,
        };
        if (d.toolCallSuccess) cur.supportsTools = true;
        if (d.toolParallel) cur.supportsParallelTools = true;
        toolEvidence.set(name, cur);
      }
    }
  }

  const snapshotMetadata = new Map<string, Record<string, unknown>>();
  for (const m of targetSnapshot?.models ?? []) {
    if (!m.metadata) continue;
    try {
      snapshotMetadata.set(
        m.model_name,
        JSON.parse(m.metadata) as Record<string, unknown>,
      );
    } catch {
      // unparseable target metadata: no prior verdict to preserve
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
    toolEvidence,
    snapshotMetadata,
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
      managedProviders: buildManagedProviders(
        config,
        providerReports,
        targetSnapshot,
      ),
      mappingSources: new Set(Object.keys(config.modelMapping)),
    },
  };
}
