import { redactExchange, redactUrl } from "@core/testing/redact";
import { saveResponseImages } from "./download";
import type { ProviderConfig } from "@core/validations/config";
import { NewApiClient } from "@core/vendors/newapi/client";
import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { ProbeTokenManager } from "./token-manager";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { RuntimeConfig } from "@core/config";
import {
  discoverCandidates,
  type Candidate,
  type DiscoveryReport,
} from "./candidates";
import { extractMaxImagesFromRejection } from "./classify";
import { resolveEndpoint } from "./endpoint-resolver";
import {
  buildGroupMap,
  compareGroupChannels,
  type GroupChannel,
} from "./group-map";
import { loadFixtures, withFixtureCount, type Fixtures } from "./fixtures";
import { probeGenerationsChannel } from "./probe-generations";
import { probeOpenAiVendorChannel } from "./probe-openai-image-edit";
import type { ProbeAttempt } from "./probe-sync";
import { probeSyncChannel } from "./probe-sync";
import { probeTaskChannel } from "./probe-task";
import {
  appendResult,
  artifactDirFor,
  isAlreadyTested,
  loadStore,
  saveDryRun,
  saveStore,
  slug,
  writeArtifact,
  type ChannelResult,
  type DryRunCandidate,
  type DryRunProvider,
  type DryRunReport,
  type ModelResult,
  type ProbeKind,
  type ProbeShape,
} from "./store";

const ESTIMATED_COST_PER_PROBE_USD = 0.1;

export interface RunImagesOpts {
  config: RuntimeConfig;
  dryRun?: boolean;
  /** When set, prompt before EACH individual probe. Default = interactive
   *  per-probe; pass false to run straight through. */
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
  const skippedProviders = opts.config.providers.filter(
    (p) => p.type !== "newapi",
  );
  for (const p of skippedProviders) {
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

  // ---- aggregate ----
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

  const saveProgress = (partial: ModelResult) => {
    appendResult(store, partial);
    saveStore(store);
  };

  let totalSpent = 0;
  // Per-provider 403 cache. Some resellers (aigc) let users create tokens for
  // groups their account isn't a member of; inference rejects with "无权访问".
  const deadGroupsByProvider = new Map<string, Set<string>>();
  // Per-provider async-billing autodetect: yun-style providers post debits
  // ~20s after the response; sync providers debit immediately. First passing
  // probe classifies; subsequent probes skip or run the 60s settle.
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

        // --step: per-probe confirm. Shows resolved wire shapes (mixed-endpoint
        // models like yun mj_blend label correctly as `task`, not stale `kind`).
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

        // Per-step balance bracketing happens INSIDE probeOneModel, around
        // each individual probe attempt (group x wire-shape). The
        // orchestrator just relays the per-step deltas the loop emits via
        // onStepCost so the live log shows movement on every attempt.
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
    // Best-effort token cleanup; never let it mask the run outcome.
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

// ─── Per-model probe loop ─────────────────────────────────────────────────

async function probeOneModel(opts: {
  provider: ProviderConfig;
  candidate: Candidate;
  groupMap: Map<string, GroupChannel[]>;
  tokens: ProbeTokenManager;
  pricing: UpstreamPricing;
  fixtures: Fixtures;
  /** Cross-model 403-dead-group cache; share + persist across the provider's models. */
  deadGroups: Set<string>;
  /** Async-billing classification state (provider-scoped). Read every step, set once on first passing probe. */
  asyncBillingState: {
    get: () => "unknown" | boolean;
    set: (v: boolean) => void;
  };
  /** Persist partial result after every channel attempt (crash-resume). */
  onProgress?: (partial: ModelResult) => void;
  /** Balance bracket per (group × shape); null when upstream exposes no quota. */
  fetchBalance?: () => Promise<number | null>;
  /** Emitted per step so the orchestrator can log running total + balance movement. */
  onStepCost?: (info: {
    channelName: string;
    probeShape: ProbeShape;
    delta: number;
    balanceAfter: number;
  }) => void;
}): Promise<ModelResult> {
  const {
    provider,
    candidate,
    groupMap,
    tokens,
    pricing,
    fixtures,
    deadGroups,
    asyncBillingState,
    onProgress,
    fetchBalance,
    onStepCost,
  } = opts;
  const groups = (groupMap.get(candidate.modelName) ?? [])
    .slice()
    .sort(compareGroupChannels);

  if (groups.length === 0) {
    return {
      provider: provider.name,
      model: candidate.modelName,
      kind: candidate.kind,
      failedChannels: [],
      decidedAt: new Date().toISOString(),
    };
  }

  // One (shape, path) per declared endpoint type via pricing.endpointPaths;
  // multi-endpoint models get one attempt per pair. Errors don't bill.
  const stepsToTry = probeStepsFor({
    endpointTypes: candidate.endpointTypes,
    primary: candidate.kind,
    modelName: candidate.modelName,
    pricing,
  });

  consola.info(
    `[${provider.name}] ${candidate.modelName}: ${groups.length} group(s), cheapest-first: ${groups.map((g) => `${g.groupName}(x${g.groupRatio})`).join(", ")}`,
  );

  const failed: ChannelResult[] = [];
  for (const g of groups) {
    const channelName = g.groupName;

    if (deadGroups.has(channelName)) {
      consola.info(
        `[${provider.name}] ${candidate.modelName} (${channelName}): skipping (auth-dead group)`,
      );
      continue;
    }

    const apiKey = await tokens.getApiKey(channelName);
    if (!apiKey) {
      consola.warn(
        `[${provider.name}] ${candidate.modelName} (${channelName}): could not resolve api key, skipping group`,
      );
      continue;
    }

    // 10s cap on balance reads so a hung /api/user/self can't drain the settle budget.
    const fetchBalanceTimed = fetchBalance
      ? async () =>
          Promise.race([
            fetchBalance(),
            new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
          ])
      : undefined;

    // Stop the (group, shape) inner loop on first PASS.
    let channelPassed: ChannelResult | undefined;
    for (const step of stepsToTry) {
      const probeShape = step.shape;
      const mkArgs = (fx: Fixtures) => ({
        baseUrl: provider.baseUrl,
        apiKey,
        userId: provider.userId,
        model: candidate.modelName,
        fixtures: fx,
        path: step.path,
      });
      const balanceBefore = fetchBalanceTimed
        ? await fetchBalanceTimed()
        : null;
      // 429 retry (3 attempts, 5/10/20s). Non-429 errors pass through to avoid double-billing real refusals.
      let attempt = await runProbeShape(probeShape, mkArgs(fixtures));
      let retriedRateLimit = 0;
      while (attempt.errorClass === "ratelimit" && retriedRateLimit < 3) {
        const wait = 5000 * 2 ** retriedRateLimit;
        consola.warn(
          `[${provider.name}] ${candidate.modelName} (${channelName}/${probeShape}): rate-limited, retry in ${wait / 1000}s (${retriedRateLimit + 1}/3)`,
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt = await runProbeShape(probeShape, mkArgs(fixtures));
        retriedRateLimit++;
      }
      // Image-count downshift (e.g. "supports 0~3 image content items. Got 6").
      // One retry only — if the trimmed payload also fails, that's the verdict.
      if (attempt.status === "fail") {
        const bodyText =
          attempt.exchange.response == null
            ? ""
            : typeof attempt.exchange.response === "string"
              ? attempt.exchange.response
              : JSON.stringify(attempt.exchange.response);
        const maxImgs = extractMaxImagesFromRejection(bodyText);
        if (
          maxImgs !== null &&
          maxImgs < fixtures.dataUris.length &&
          maxImgs >= 1
        ) {
          consola.warn(
            `[${provider.name}] ${candidate.modelName} (${channelName}/${probeShape}): upstream caps refs at ${maxImgs}, retrying with ${maxImgs} images`,
          );
          attempt = await runProbeShape(
            probeShape,
            mkArgs(withFixtureCount(fixtures, maxImgs)),
          );
        }
      }
      // Async-billing settle: yun-style providers debit ~20s after response.
      // unknown -> probe 20s, classify provider; true -> full 60s settle;
      // false -> skip (immediate read is truth). Failures don't trigger settle.
      let balanceAfter = fetchBalanceTimed ? await fetchBalanceTimed() : null;
      let stepDelta =
        balanceBefore !== null && balanceAfter !== null
          ? balanceBefore - balanceAfter
          : undefined;
      const noImmediateDebit =
        attempt.status === "ok" &&
        balanceBefore !== null &&
        stepDelta !== undefined &&
        Math.abs(stepDelta) < 0.0001 &&
        fetchBalanceTimed !== undefined;
      if (noImmediateDebit) {
        const billing = asyncBillingState.get();
        if (billing === false) {
          // sync provider: $0 read is truth
        } else if (billing === true) {
          ({ balanceAfter, stepDelta } = await pollSettle({
            balanceBefore: balanceBefore!,
            fetchBalance: fetchBalanceTimed!,
            label: `[${provider.name}] ${candidate.modelName} (${channelName}/${probeShape})`,
            budgetMs: 60_000,
            initialAfter: balanceAfter,
            initialDelta: stepDelta,
          }));
        } else {
          const probed = await pollSettle({
            balanceBefore: balanceBefore!,
            fetchBalance: fetchBalanceTimed!,
            label: `[${provider.name}] ${candidate.modelName} (${channelName}/${probeShape})`,
            budgetMs: 20_000,
            initialAfter: balanceAfter,
            initialDelta: stepDelta,
          });
          balanceAfter = probed.balanceAfter;
          stepDelta = probed.stepDelta;
          const settled =
            stepDelta !== undefined && Math.abs(stepDelta) >= 0.0001;
          asyncBillingState.set(settled);
          consola.debug(
            `[${provider.name}] async-billing autodetect: ${settled ? "yes (will settle subsequent passes)" : "no (skip future settles)"}`,
          );
        }
      }

      const redacted = redactExchange(attempt.exchange);
      const artifactPath = writeArtifact(
        provider.name,
        candidate.modelName,
        channelName,
        probeShape,
        redacted,
      );

      // Save image bytes (run for fail too — heuristic might miss an image).
      // Pass the original (non-redacted) response so data: URIs survive intact.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const savedImages = await saveResponseImages({
        response: attempt.exchange.response,
        dir: artifactDirFor(provider.name, candidate.modelName),
        basenamePrefix: `${ts}-${slug(channelName)}-${probeShape}`,
      });

      const cr: ChannelResult = {
        channelName,
        exchange: redacted,
        errorClass: attempt.errorClass,
        artifactPath,
        imagePaths:
          savedImages.length > 0 ? savedImages.map((s) => s.path) : undefined,
        imageResolutions:
          savedImages.length > 0
            ? savedImages.map((s) => ({ w: s.w, h: s.h }))
            : undefined,
        probeKind: shapeToKind(probeShape),
        probeShape,
        hasImageInputs: shapeHasImageInputs(probeShape),
        groupRatio: g.groupRatio,
        costUsd: stepDelta,
        attemptedAt: new Date().toISOString(),
        taskId: attempt.taskId,
      };

      if (stepDelta !== undefined && balanceAfter !== null) {
        onStepCost?.({
          channelName,
          probeShape,
          delta: stepDelta,
          balanceAfter,
        });
      }

      if (attempt.status === "ok") {
        channelPassed = cr;
        break;
      }
      failed.push(cr);
      // 403 here will hit every remaining model on this group — mark dead.
      if (attempt.errorClass === "auth") {
        deadGroups.add(channelName);
        consola.warn(
          `[${provider.name}] ${candidate.modelName} (${channelName}): auth 403, marking group dead for rest of run`,
        );
        onProgress?.({
          provider: provider.name,
          model: candidate.modelName,
          kind: candidate.kind,
          failedChannels: failed,
          decidedAt: new Date().toISOString(),
        });
        break;
      }
      // Persist after every shape attempt so a crash keeps prior work.
      onProgress?.({
        provider: provider.name,
        model: candidate.modelName,
        kind: candidate.kind,
        failedChannels: failed,
        decidedAt: new Date().toISOString(),
      });
    }

    if (channelPassed) {
      consola.success(
        t("CORE.IMAGES.RESULT_PASS", {
          provider: provider.name,
          model: candidate.modelName,
          channel: channelName,
        }),
      );
      const decided: ModelResult = {
        provider: provider.name,
        model: candidate.modelName,
        kind: candidate.kind,
        workingChannelName: channelName,
        // Inline the winning channel's full exchange so the master file
        // carries request/response/headers/status/latency without having
        // to open the per-attempt artifact json. Mirrors what we already
        // store in failedChannels[] for failed attempts.
        workingChannel: channelPassed,
        failedChannels: failed,
        decidedAt: new Date().toISOString(),
      };
      onProgress?.(decided);
      return decided;
    }

    // Gateway-broken model abort: gateway routing is global, not per-group.
    // One body-translator signature ("contents is required" etc.) means every
    // other group will hit the same error — skip remaining groups.
    const channelAttempts = failed.slice(-stepsToTry.length);
    if (channelAttempts.some((a) => isGatewayBrokenSignature(a))) {
      consola.warn(
        `[${provider.name}] ${candidate.modelName}: gateway-broken body signature on ${channelName} (translator can't route this model), skipping remaining groups`,
      );
      break;
    }
  }

  consola.warn(
    t("CORE.IMAGES.RESULT_FAIL", {
      provider: provider.name,
      model: candidate.modelName,
      channels: failed.length,
    }),
  );
  return {
    provider: provider.name,
    model: candidate.modelName,
    kind: candidate.kind,
    failedChannels: failed,
    decidedAt: new Date().toISOString(),
  };
}

/** Poll balance every 2s until a debit lands or budget runs out. */
async function pollSettle(opts: {
  balanceBefore: number;
  fetchBalance: () => Promise<number | null>;
  label: string;
  budgetMs: number;
  initialAfter: number | null;
  initialDelta: number | undefined;
}): Promise<{ balanceAfter: number | null; stepDelta: number | undefined }> {
  let balanceAfter = opts.initialAfter;
  let stepDelta = opts.initialDelta;
  const deadline = Date.now() + opts.budgetMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    pollCount++;
    const b = await opts.fetchBalance();
    if (b !== null && Math.abs(opts.balanceBefore - b) >= 0.0001) {
      balanceAfter = b;
      stepDelta = opts.balanceBefore - b;
      consola.debug(`${opts.label}: debit landed after ${pollCount * 2}s`);
      break;
    }
  }
  return { balanceAfter, stepDelta };
}

function runProbeShape(
  shape: ProbeShape,
  opts: {
    baseUrl: string;
    apiKey: string;
    userId: number;
    model: string;
    fixtures: Fixtures;
    /** Provider-declared URL override (Replicate, Tencent VOD, etc); undefined → probe default. */
    path?: string;
  },
): Promise<ProbeAttempt> {
  if (shape === "sync-edits") return probeSyncChannel(opts);
  if (shape === "sync-generations") return probeGenerationsChannel(opts);
  if (shape === "openai-vendor") return probeOpenAiVendorChannel(opts);
  return probeTaskChannel(opts);
}

function shapeToKind(shape: ProbeShape): ProbeKind {
  if (shape === "sync-edits" || shape === "sync-generations") return "sync";
  if (shape === "task") return "task";
  return "openai-vendor";
}

/** Only sync-generations is text-to-image; the rest carry the 6 refs. */
function shapeHasImageInputs(shape: ProbeShape): boolean {
  return shape !== "sync-generations";
}

/**
 * Names that need refs regardless of advertised endpoint. Many edit-only models
 * on resellers are mis-listed under image-generation; probing text-only yields
 * "Missing required key: image" 400s. Adding edit-style shapes for these names
 * exercises the multipart + chat-multimodal paths that actually carry refs.
 */
const NAME_REQUIRES_REFS = [
  "edit",
  "kontext",
  "i2i",
  "i2v",
  "img2img",
  "image-to-image",
  "image-to-video",
  "redux",
  "remix",
];

/**
 * One probe step: a (wire shape, URL path) pair the orchestrator should
 * attempt. The path is the actual upstream URL resolved from the
 * provider's `endpointPaths` declaration, or undefined when the probe
 * should use its built-in default path.
 */
interface ProbeStep {
  shape: ProbeShape;
  /** Provider-declared URL path. Undefined => use probe module's default. */
  path?: string;
}

/**
 * One (shape, path) step per declared endpoint type, deduped by `shape|path`.
 * Multi-endpoint models get one attempt per pair; errors don't bill.
 *
 * Name-based override (NAME_REQUIRES_REFS): edit/kontext/i2i/etc models add
 * sync-edits + openai-vendor steps even when the gateway only advertises
 * text-to-image, because text-only triggers "Missing required key: image".
 * Dedup by shape prevents double-billing openai-vendor on *edit* models that
 * already declared the `openai` endpoint.
 */
function probeStepsFor(opts: {
  endpointTypes: string[];
  primary: ProbeKind;
  modelName: string;
  pricing: UpstreamPricing;
}): ProbeStep[] {
  const seen = new Set<string>();
  const steps: ProbeStep[] = [];
  const add = (shape: ProbeShape, path?: string) => {
    const key = `${shape}|${path ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ shape, path });
  };

  for (const e of opts.endpointTypes) {
    const resolved = resolveEndpoint({
      endpointType: e,
      modelName: opts.modelName,
      pricing: opts.pricing,
    });
    if (resolved) add(resolved.shape, resolved.path);
  }

  const lowerName = opts.modelName.toLowerCase();
  if (NAME_REQUIRES_REFS.some((k) => lowerName.includes(k))) {
    const haveShape = (s: ProbeShape) => steps.some((st) => st.shape === s);
    if (!haveShape("sync-edits")) add("sync-edits");
    if (!haveShape("openai-vendor")) add("openai-vendor");
  }

  if (steps.length === 0) {
    if (opts.primary === "sync") add("sync-edits");
    else if (opts.primary === "openai-vendor") add("openai-vendor");
    else add("task");
  }
  return steps;
}

/**
 * Gateway can't translate any wire shape to upstream (e.g. aigc routes Imagen
 * to Gemini/OpenAI but Imagen actually wants :predict). Both routes reject:
 * OAI->Gemini gives "contents is required"; Gemini multimodal gives
 * "Unknown name contents/instances/parts/generationConfig/safetySettings".
 * Gateway routing is global, so one signature means every group will fail
 * the same way — abort the model.
 */
function isGatewayBrokenSignature(attempt: ChannelResult): boolean {
  if (attempt.errorClass !== "ref_count_rejected") return false;
  const body =
    attempt.exchange.response == null
      ? ""
      : typeof attempt.exchange.response === "string"
        ? attempt.exchange.response
        : JSON.stringify(attempt.exchange.response);
  return (
    /contents is required/i.test(body) ||
    /Unknown name "(?:contents|instances|parts|generationConfig|safetySettings)"/.test(
      body,
    )
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildDryRunProvider(opts: {
  provider: ProviderConfig;
  totalModels: number;
  totalChannels: number;
  discovery: DiscoveryReport;
  groupMap: Map<string, GroupChannel[]>;
}): DryRunProvider {
  const { provider, totalModels, totalChannels, discovery, groupMap } = opts;
  const candidates: DryRunCandidate[] = discovery.candidates.map((c) => {
    const chs = (groupMap.get(c.modelName) ?? [])
      .slice()
      .sort(compareGroupChannels);
    return {
      model: c.modelName,
      canonicalKey: c.canonicalKey,
      aliases: c.aliases,
      kind: c.kind,
      endpointTypes: c.endpointTypes,
      tags: c.tags,
      vendorId: c.vendorId,
      channels: chs.map((g) => ({
        id: 0,
        name: g.groupName,
        priority: 0,
        weight: 0,
      })),
      reasons: c.reasons,
    };
  });
  return {
    name: provider.name,
    baseUrl: redactUrl(provider.baseUrl),
    totalModels,
    totalChannels,
    candidates,
    excluded: discovery.excluded.map((e) => ({
      model: e.modelName,
      reason: e.reason,
    })),
  };
}

/** Re-fetch raw /api/pricing to recover V2 model_info.tags that parsePricing discards. */
async function tryFetchLegacyModelInfo(
  provider: ProviderConfig,
): Promise<
  | Record<string, { supplier?: string; tags?: string[]; illustrate?: string }>
  | undefined
> {
  const url = provider.baseUrl.replace(/\/$/, "") + "/api/pricing";
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${provider.systemAccessToken}`,
        "New-Api-User": String(provider.userId),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return undefined;
    const json = (await r.json()) as {
      data?: {
        model_info?: Record<
          string,
          { supplier?: string; tags?: string[]; illustrate?: string }
        >;
      };
    };
    return json?.data?.model_info;
  } catch {
    return undefined;
  }
}
