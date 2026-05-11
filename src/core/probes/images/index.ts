import type { RuntimeConfig } from "@core/config";
import type { ProviderConfig } from "@core/validations/config";
import { NewApiClient } from "@core/vendors/newapi/client";
import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import {
  discoverCandidates,
  type DiscoveryReport,
  type ProbeKind,
} from "./candidates";
import { buildDryRunProvider, tryFetchLegacyModelInfo } from "./dry-run";
import { loadFixtures } from "./fixtures";
import { buildGroupMap, type GroupChannel } from "./group-map";
import { probeOneModel } from "./loop";
import { probeStepsFor } from "./planner";
import {
  appendResult,
  isAlreadyTested,
  loadStore,
  saveDryRun,
  saveStore,
  type DryRunProvider,
  type DryRunReport,
  type ModelResult,
} from "./store";
import { ProbeTokenManager } from "./token-manager";

const ESTIMATED_COST_PER_PROBE_USD = 0.1;

export interface RunImagesOpts {
  config: RuntimeConfig;
  dryRun?: boolean;
  /** When set, prompt before EACH individual probe. Default = straight-through. */
  step?: boolean;
}

export interface RunImagesReport {
  totalCandidates: number;
  toProbe: number;
  cached: number;
  passed: number;
  failed: number;
  noChannel: number;
  durationMs: number;
}

/** Probe every newapi provider for working image-edit channels. Dry-run writes logs/images-dry-run.json without hitting upstreams. */
export async function runImageProbe(
  opts: RunImagesOpts,
): Promise<RunImagesReport> {
  const startedAt = performance.now();
  const fixtures = await loadFixtures();
  const store = loadStore();

  const newapiProviders = opts.config.providers.filter(
    (p): p is ProviderConfig => p.type === "newapi",
  );
  for (const p of opts.config.providers.filter((p) => p.type !== "newapi")) {
    consola.warn(
      t("CORE.IMAGES.SKIPPING_NON_NEWAPI_PROVIDER", {
        name: p.name,
        type: p.type,
      }),
    );
  }

  // ─── Discovery + dry-run ────────────────────────────────────────────────
  const dryRunProviders: DryRunProvider[] = [];
  const candidatesByProvider = new Map<
    string,
    {
      provider: ProviderConfig;
      client: NewApiClient;
      groupMap: Map<string, GroupChannel[]>;
      discovery: DiscoveryReport;
      tokens: ProbeTokenManager;
      pricing: UpstreamPricing;
    }
  >();

  for (const provider of newapiProviders) {
    consola.info(t("CORE.IMAGES.PROVIDER_SCANNING", { name: provider.name }));
    const client = new NewApiClient(provider, provider.name);
    let pricing;
    try {
      pricing = await client.fetchPricing();
    } catch (err) {
      consola.warn(
        t("CORE.IMAGES.PRICING_FAILED", {
          name: provider.name,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      continue;
    }

    const legacyModelInfo = await tryFetchLegacyModelInfo(provider);
    const discovery = discoverCandidates({
      providerName: provider.name,
      pricing,
      legacyModelInfo,
      modelNameFilter: opts.config.modelFilter ?? [],
    });

    const tokens = new ProbeTokenManager(client.ctx, provider.name);
    if (!opts.dryRun) {
      try {
        await tokens.preloadList();
      } catch (err) {
        consola.warn(
          t("CORE.IMAGES.NO_INFERENCE_TOKEN", {
            name: provider.name,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
        continue;
      }
    }

    const groupMap = buildGroupMap(pricing);
    candidatesByProvider.set(provider.name, {
      provider,
      client,
      groupMap,
      discovery,
      tokens,
      pricing,
    });

    if (opts.dryRun) {
      dryRunProviders.push(
        buildDryRunProvider({
          provider,
          totalModels: pricing.models.length,
          totalChannels: pricing.groups.length,
          discovery,
          groupMap,
        }),
      );
    }
  }

  // ─── Aggregate ──────────────────────────────────────────────────────────
  let totalCandidates = 0;
  let cached = 0;
  let toProbe = 0;
  const byKind: Record<ProbeKind, number> = {
    sync: 0,
    "openai-vendor": 0,
    task: 0,
  };
  for (const { provider, discovery } of candidatesByProvider.values()) {
    for (const c of discovery.candidates) {
      totalCandidates++;
      byKind[c.kind]++;
      if (isAlreadyTested(store, provider.name, c.modelName)) cached++;
      else toProbe++;
    }
  }

  consola.info(
    t("CORE.IMAGES.CANDIDATES_FOUND", {
      total: totalCandidates,
      providers: candidatesByProvider.size,
      toProbe,
      cached,
    }),
  );

  if (opts.dryRun) {
    const report: DryRunReport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: dryRunProviders,
      summary: {
        totalCandidates,
        byKind,
        estimatedMaxCost: +(toProbe * ESTIMATED_COST_PER_PROBE_USD).toFixed(2),
        alreadyDecided: cached,
      },
    };
    const path = saveDryRun(report);
    consola.success(t("CORE.IMAGES.DRY_RUN_WRITTEN", { path }));
    return {
      totalCandidates,
      toProbe,
      cached,
      passed: 0,
      failed: 0,
      noChannel: 0,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  // Informational only; --step prompts per-probe and streaming mode already opted in.
  const estimate = +(toProbe * ESTIMATED_COST_PER_PROBE_USD).toFixed(2);
  consola.info(
    t("CORE.IMAGES.ESTIMATED_COST", { cost: estimate, count: toProbe }),
  );

  // ─── Probe loop ──────────────────────────────────────────────────────────
  // Sequential by design: parallel probes saturate upstream rate limits and
  // we save after every channel attempt for crash-resume.
  let passed = 0;
  let failed = 0;
  let noChannel = 0;
  let totalSpent = 0;

  const saveProgress = (partial: ModelResult) => {
    appendResult(store, partial);
    saveStore(store);
  };

  // Per-provider 403 cache (aigc-style tokens that don't actually grant the
  // group). Per-provider async-billing autodetect (yun debits async ~20s
  // after response; sync providers debit immediately).
  const deadGroupsByProvider = new Map<string, Set<string>>();
  const asyncBillingByProvider = new Map<string, "unknown" | boolean>();

  try {
    outer: for (const [
      providerName,
      { provider, client, groupMap, discovery, tokens, pricing },
    ] of candidatesByProvider) {
      const deadGroups = new Set<string>();
      deadGroupsByProvider.set(providerName, deadGroups);
      asyncBillingByProvider.set(providerName, "unknown");

      for (const c of discovery.candidates) {
        if (isAlreadyTested(store, providerName, c.modelName)) continue;

        if (opts.step) {
          const planned = probeStepsFor({
            endpointTypes: c.endpointTypes,
            primary: c.kind,
            modelName: c.modelName,
            pricing,
          });
          const shapes = [...new Set(planned.map((s) => s.shape))].join(",");
          const ok = await consola.prompt(
            `Probe [${providerName}] ${c.modelName} (${shapes})?`,
            { type: "confirm" },
          );
          if (!ok) {
            consola.info(t("CORE.IMAGES.ABORTED_BY_USER"));
            break outer;
          }
        }

        const result = await probeOneModel({
          provider,
          candidate: c,
          groupMap,
          tokens,
          pricing,
          fixtures,
          deadGroups,
          asyncBillingState: {
            get: () => asyncBillingByProvider.get(providerName) ?? "unknown",
            set: (v) => asyncBillingByProvider.set(providerName, v),
          },
          onProgress: saveProgress,
          fetchBalance: () => client.fetchBalance(),
          onStepCost: ({ channelName, probeShape, delta, balanceAfter }) => {
            totalSpent += Math.max(0, delta);
            const costStr =
              delta < -0.0001
                ? "+$" + Math.abs(delta).toFixed(4) + " (refund?)"
                : "$" + delta.toFixed(4);
            consola.info(
              `[${providerName}] ${c.modelName} (${channelName}/${probeShape}): cost ${costStr} | running total: $${totalSpent.toFixed(4)} | balance: $${balanceAfter.toFixed(4)}`,
            );
          },
        });
        appendResult(store, result);
        saveStore(store);
        if (result.workingChannelName !== undefined) passed++;
        else if (result.failedChannels.length === 0) noChannel++;
        else failed++;
      }
    }
  } finally {
    for (const { tokens } of candidatesByProvider.values()) {
      try {
        await tokens.cleanup();
      } catch {
        /* warned inside cleanup */
      }
    }
    if (totalSpent > 0) {
      consola.info(
        `Total actual spend across this run: $${totalSpent.toFixed(4)}`,
      );
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  consola.success(
    t("CORE.IMAGES.SUMMARY", {
      total: toProbe,
      passed,
      failed,
      noChannel,
      durationSec: (durationMs / 1000).toFixed(1),
    }),
  );

  return {
    totalCandidates,
    toProbe,
    cached,
    passed,
    failed,
    noChannel,
    durationMs,
  };
}
