import { redactExchange, redactUrl } from "@core/testing/redact";
import { saveResponseImages } from "./download";
import type { ProviderConfig } from "@core/validations/config";
import { NewApiClient } from "@core/vendors/newapi/client";
import type { ClientContext } from "@core/vendors/newapi/context";
import { ProbeTokenManager } from "./token-manager";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { RuntimeConfig } from "@core/config";
import {
  discoverCandidates,
  type Candidate,
  type DiscoveryReport,
} from "./candidates";
import {
  buildGroupMap,
  compareGroupChannels,
  type GroupChannel,
} from "./group-map";
import { loadFixtures, type Fixtures } from "./fixtures";
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

/**
 * Run the image-edit channel probe against every newapi-typed provider in
 * the resolved RuntimeConfig. Honors `--only` / `--models` upstream filters
 * (already applied to `config.providers` and `config.modelFilter`).
 *
 * In dry-run mode: writes `logs/images-dry-run.json` and returns without
 * sending any upstream requests.
 */
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
      t("CORE.IMAGES.SKIPPING_NON_NEWAPI_PROVIDER", { name: p.name, type: p.type }),
    );
  }

  // ---- discovery + dry-run ----
  const dryRunProviders: DryRunProvider[] = [];
  const candidatesByProvider = new Map<
    string,
    {
      provider: ProviderConfig;
      client: NewApiClient;
      groupMap: Map<string, GroupChannel[]>;
      discovery: DiscoveryReport;
      /** Lazy token resolver. Inference keys are unmasked / created only
       *  when the probe actually walks into a group, never up front. */
      tokens: ProbeTokenManager;
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

    // Lazy per-group token manager. Lists existing tokens ONCE per
    // provider (paginated, 429-retried) and caches the masked metadata.
    // Full keys / creates / deletes happen on demand inside probeOneModel
    // when each group is actually visited, so providers that throttle
    // /api/token/{id}/key (pol returns 429 on every call) only fail the
    // groups whose key actually resolves - not the whole provider. The
    // group-map carries (groupName, "" placeholder); the real apiKey is
    // resolved per probe via `tokens.getApiKey(groupName)`.
    const tokens = new ProbeTokenManager(getCtx(client), provider.name);
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

  // ---- cost estimate (informational only) ----
  // The whole-run cost guard is gone: in --step mode the user confirms each
  // probe individually, so an upfront prompt is redundant. In streaming
  // (non-step) mode the user already opted into running by not passing
  // --step, so don't double-prompt.
  const estimate = +(toProbe * ESTIMATED_COST_PER_PROBE_USD).toFixed(2);
  consola.info(
    t("CORE.IMAGES.ESTIMATED_COST", { cost: estimate, count: toProbe }),
  );

  // ---- probe loop ----
  // Sequential execution: one probe at a time. Image-edit probes are slow
  // (multipart upload + 90s timeout, video tasks poll for up to 10min) and
  // running them in parallel saturates upstream rate limits. We also want
  // deterministic, restartable runs - so the store is saved after every
  // single channel attempt, not just at end-of-model. Crash mid-run? Next
  // run picks up exactly where this one stopped.
  let passed = 0;
  let failed = 0;
  let noChannel = 0;

  // Save callback handed to probeOneModel so it can persist after each
  // channel attempt, not just at end-of-model.
  const saveProgress = (partial: ModelResult) => {
    appendResult(store, partial);
    saveStore(store);
  };

  let totalSpent = 0;
  try {
    let aborted = false;
    outer: for (const [
      providerName,
      { provider, client, groupMap, discovery, tokens },
    ] of candidatesByProvider) {
      for (const c of discovery.candidates) {
        if (isAlreadyTested(store, providerName, c.modelName)) continue;

        // --step: confirm each probe individually so the user can stop
        // mid-run after observing results. Default behavior (no --step) is
        // straight-through.
        if (opts.step) {
          const ok = await consola.prompt(
            `Probe [${providerName}] ${c.modelName} (${c.kind})?`,
            { type: "confirm" },
          );
          if (!ok) {
            consola.info(t("CORE.IMAGES.ABORTED_BY_USER"));
            aborted = true;
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
          fixtures,
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
        if (result.workingChannelId !== undefined) passed++;
        else if (result.failedChannels.length === 0) noChannel++;
        else failed++;
      }
    }
    if (aborted) {
      // Fall through to summary so the user sees what they got.
    }
  } finally {
    // Delete only tokens this run created (existing ones owned by regular
    // sync are left alone). Failures log a warning but don't throw - we
    // never want cleanup errors to mask the run's own outcome.
    for (const { tokens } of candidatesByProvider.values()) {
      try {
        await tokens.cleanup();
      } catch {
        /* warned inside cleanup */
      }
    }
    if (totalSpent > 0) {
      consola.info(`Total actual spend across this run: $${totalSpent.toFixed(4)}`);
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

  return { totalCandidates, toProbe, cached, passed, failed, noChannel, durationMs };
}

// ---------------------------------------------------------------------------
// Per-model probe loop
// ---------------------------------------------------------------------------

async function probeOneModel(opts: {
  provider: ProviderConfig;
  candidate: Candidate;
  groupMap: Map<string, GroupChannel[]>;
  /** Lazy token manager. `getApiKey(group)` is called per group on first
   *  visit; result is cached for the rest of the run. */
  tokens: ProbeTokenManager;
  fixtures: Fixtures;
  /** Persist a partial ModelResult after every channel attempt so the
   *  store survives Ctrl-C / network errors mid-loop and resume picks up
   *  with no lost work. */
  onProgress?: (partial: ModelResult) => void;
  /** Per-step balance reader. Bracketed around EACH probe attempt
   *  (group × shape) so the user sees movement after every wire-shape
   *  test, not only at end-of-model. Returns null when the upstream
   *  doesn't expose a quota balance. */
  fetchBalance?: () => Promise<number | null>;
  /** Called after each step with the measured delta + cumulative running
   *  total so the orchestrator can log balance movement consistently. */
  onStepCost?: (info: {
    channelName: string;
    probeShape: ProbeShape;
    delta: number;
    balanceAfter: number;
  }) => void;
}): Promise<ModelResult> {
  const { provider, candidate, groupMap, tokens, fixtures, onProgress, fetchBalance, onStepCost } = opts;
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

  // Derive every wire shape the model's endpoint_types support. Models with
  // both `image-generation` AND `openai编辑图片` (or both `openai` AND
  // `image-generation`) get one attempt per shape so we capture how each
  // endpoint behaves. Errors don't bill so probing extra shapes is free.
  const shapesToTry = probeShapesFor(
    candidate.endpointTypes,
    candidate.kind,
    candidate.modelName,
  );

  // Tell the user the planned probe order before we start hitting the
  // upstream. Cheapest tier first means a quick PASS on the cheap group
  // skips the rest entirely - useful for sanity-checking which groups are
  // actually being burned through.
  consola.info(
    `[${provider.name}] ${candidate.modelName}: ${groups.length} group(s), cheapest-first: ${groups.map((g) => `${g.groupName}(x${g.groupRatio})`).join(", ")}`,
  );

  const failed: ChannelResult[] = [];
  for (const g of groups) {
    // Group name is the "channel name" surfaced in results: each group is a
    // distinct routing bucket on new-api with its own bound token.
    const channelName = g.groupName;
    const channelId = 0; // Pricing surface doesn't expose channel ids.

    // Resolve the inference api key on first probe of this group. The
    // manager creates the token if missing, fetches the unmasked key
    // (with 429 retry), and caches both for later groups + reruns. A
    // null return means the upstream wouldn't let us acquire a usable
    // key for this group (e.g. /key endpoint permanently throttled), so
    // skip this group and keep going - other groups may still work.
    const apiKey = await tokens.getApiKey(channelName);
    if (!apiKey) {
      consola.warn(
        `[${provider.name}] ${candidate.modelName} (${channelName}): could not resolve api key, skipping group`,
      );
      continue;
    }

    // Within a group, try each wire shape. Stop on first PASS - if
    // /v1/images/edits worked we don't need to also try /v1/images/generations.
    let channelPassed: ChannelResult | undefined;
    for (const probeShape of shapesToTry) {
      // Balance bracket per STEP (group x shape): so users see balance
      // movement on every probe attempt, not just per model. fetchBalance
      // is undefined / returns null when the upstream lacks a quota field.
      const balanceBefore = fetchBalance ? await fetchBalance() : null;
      // Retry on 429: rate-limited probes get up to 3 attempts with
      // exponential backoff before we record the failure. A genuine
      // 429-on-everything provider will still surface in the artifact
      // (final attempt's response carries the 429 body). Other status
      // codes pass through immediately - we don't want to retry a real
      // refusal / 4xx and double-bill.
      let attempt = await runProbeShape(probeShape, {
        baseUrl: provider.baseUrl,
        apiKey,
        userId: provider.userId,
        channelId,
        model: candidate.modelName,
        fixtures,
      });
      let retriedRateLimit = 0;
      while (
        attempt.errorClass === "ratelimit" &&
        retriedRateLimit < 3
      ) {
        const wait = 5000 * 2 ** retriedRateLimit; // 5s / 10s / 20s
        consola.warn(
          `[${provider.name}] ${candidate.modelName} (${channelName}/${probeShape}): rate-limited, retry in ${wait / 1000}s (${retriedRateLimit + 1}/3)`,
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt = await runProbeShape(probeShape, {
          baseUrl: provider.baseUrl,
          apiKey,
          userId: provider.userId,
          channelId,
          model: candidate.modelName,
          fixtures,
        });
        retriedRateLimit++;
      }
      // Async billing settle: yun (and likely other resellers) post the
      // quota debit a few seconds AFTER the HTTP response returns.
      // Reading balance immediately yields the pre-debit value, which
      // surfaces as a bogus $0.0000 cost on probes that actually billed.
      //
      // Strategy:
      // - Failures: read once. Failures usually don't bill; if upstream
      //   does charge for compute on errors that delta will surface
      //   immediately or stay at 0 - either way we don't wait.
      // - Passes: passes ALWAYS bill on yun et al. Poll every 2s until
      //   we see ANY balance change, capped at 60s as a safety net so a
      //   genuinely-free upstream (or one with broken /api/user/self)
      //   doesn't hang the run forever.
      let balanceAfter = fetchBalance ? await fetchBalance() : null;
      let stepDelta =
        balanceBefore !== null && balanceAfter !== null
          ? balanceBefore - balanceAfter
          : undefined;
      if (
        attempt.status === "ok" &&
        balanceBefore !== null &&
        stepDelta !== undefined &&
        Math.abs(stepDelta) < 0.0001 &&
        fetchBalance
      ) {
        const settleDeadline = Date.now() + 60_000;
        let pollCount = 0;
        while (Date.now() < settleDeadline) {
          await new Promise((r) => setTimeout(r, 2000));
          pollCount++;
          const b = await fetchBalance();
          if (b !== null && Math.abs(balanceBefore - b) >= 0.0001) {
            balanceAfter = b;
            stepDelta = balanceBefore - b;
            consola.debug(
              `[${provider.name}] ${candidate.modelName} (${channelName}/${probeShape}): debit landed after ${pollCount * 2}s`,
            );
            break;
          }
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

      // Save the actual generated image bytes (URL download or base64
      // decode) to disk before the upstream CDN URL expires. Run for both
      // pass and fail attempts: a failed-classification probe (e.g. our
      // heuristic didn't see an image, but the body still has one) is
      // exactly the case we want bytes for, to inspect what the model
      // actually produced. We pass the ORIGINAL response, not the
      // redacted one - the redactor could in theory mangle data: URIs.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const imagePaths = await saveResponseImages({
        response: attempt.exchange.response,
        dir: artifactDirFor(provider.name, candidate.modelName),
        basenamePrefix: `${ts}-${slugForFile(channelName)}-${probeShape}`,
      });

      const cr: ChannelResult = {
        channelId,
        channelName,
        exchange: redacted,
        errorClass: attempt.errorClass,
        artifactPath,
        imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
        probeKind: shapeToKind(probeShape),
        probeShape,
        hasImageInputs: shapeHasImageInputs(probeShape),
        groupRatio: g.groupRatio,
        costUsd: stepDelta,
        attemptedAt: new Date().toISOString(),
        taskId: attempt.taskId,
      };

      // Surface this step's balance movement to the orchestrator so the
      // user sees per-attempt cost in the live log, not only the per-model
      // aggregate. Pass through balanceAfter so callers can update their
      // running totals + balance display.
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
      // Persist mid-loop so a crash on the next shape doesn't lose the
      // already-tried wire shape.
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
        workingChannelId: channelId,
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

function runProbeShape(
  shape: ProbeShape,
  opts: {
    baseUrl: string;
    apiKey: string;
    userId: number;
    channelId: number;
    model: string;
    fixtures: Fixtures;
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

/**
 * Whether a probe shape attaches the 6 reference fixtures to its request.
 * `sync-generations` is the only shape that doesn't (text-to-image only) -
 * the rest send the refs as multipart parts, multimodal `image_url` parts,
 * or task-submission `images[]`. A passing `sync-generations` probe means
 * the gateway returned an image but the model never actually saw the
 * reference fixtures, so the result has limited value for the 6-character
 * compose workload.
 */
function shapeHasImageInputs(shape: ProbeShape): boolean {
  return shape !== "sync-generations";
}

/**
 * Names that signal the model REQUIRES reference images regardless of what
 * endpoint type the gateway declares. Many edit-only models on resellers
 * are mis-listed under `image-generation` (the t2i endpoint), so when we
 * probe with text-only we get `"Missing required key: image"` 400s. By
 * also adding edit-style shapes for these names we exercise the multipart
 * + chat-multimodal paths that actually carry the refs.
 */
const NAME_REQUIRES_REFS = [
  "edit",       // qwen-image-edit-*, seededit, flux-kontext-edit
  "kontext",    // flux-kontext-* are reference-conditioned
  "i2i",        // image-to-image
  "i2v",        // image-to-video (refs required)
  "img2img",
  "image-to-image",
  "image-to-video",
  "redux",      // flux redux is image-conditioned
  "remix",      // ideogram remix is reference-conditioned
];

/**
 * Derive the full list of wire shapes to test for a candidate. When a model
 * advertises multiple endpoint types (e.g. yun's gpt-image-2 has both
 * `openai编辑图片` AND `image-generation`), each shape gets its own attempt:
 * `/v1/images/edits` (sync-edits, multipart) AND `/v1/images/generations`
 * (sync-generations, JSON). User-visible ground truth per endpoint.
 *
 * Also factors in the MODEL NAME: edit/i2i/kontext/remix-style models
 * always test the multipart + chat-multimodal paths even when the gateway
 * only declares `image-generation` for them, because text-only would
 * trigger "Missing required key: image" rejections.
 *
 * Always at least one shape: derived from the candidate's primary `kind`
 * when endpointTypes are missing/non-standard.
 */
function probeShapesFor(
  endpointTypes: string[],
  primary: ProbeKind,
  modelName?: string,
): ProbeShape[] {
  const shapes = new Set<ProbeShape>();
  for (const e of endpointTypes) {
    const lower = e.toLowerCase();
    // Edit endpoints (multipart upload to /v1/images/edits).
    if (
      lower === "image-edit" ||
      lower === "aigc-image-edit" ||
      lower.includes("编辑图片")
    ) {
      shapes.add("sync-edits");
    }
    // Generation endpoints (JSON to /v1/images/generations).
    if (
      lower === "image-generation" ||
      lower === "openai-image" ||
      lower === "aigc-image" ||
      lower === "dall-e-3"
    ) {
      shapes.add("sync-generations");
    }
    // Chat-completions translation surface.
    if (lower === "openai" || lower === "anthropic") {
      shapes.add("openai-vendor");
    }
    // Video task surface excluded at discovery; nothing to add here.
  }

  // Name-based override: edit/i2i/kontext models need refs even when the
  // gateway only advertises image-generation. Add the ref-carrying shapes
  // so we don't get stuck submitting text-only requests that get rejected
  // for "Missing required key: image".
  if (modelName) {
    const lowerName = modelName.toLowerCase();
    if (NAME_REQUIRES_REFS.some((k) => lowerName.includes(k))) {
      shapes.add("sync-edits");
      shapes.add("openai-vendor");
    }
  }

  if (shapes.size === 0) {
    // Fall back to primary kind (used for legacy V2 yun shape where
    // endpointTypes may be empty and we derived kind from the model name).
    if (primary === "sync") shapes.add("sync-edits");
    else if (primary === "openai-vendor") shapes.add("openai-vendor");
    else shapes.add("task");
  }
  return [...shapes];
}

/**
 * Sanitize a group name for use inside a filename. Mirrors `slug()` in
 * store.ts so attribution stays consistent across artifact paths.
 */
function slugForFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "_";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the internal `ClientContext` of a `NewApiClient`. The class keeps
 * `ctx` as a private getter; we avoid the boilerplate of plumbing every
 * helper through the class by reading it via a small adapter.
 */
function getCtx(client: NewApiClient): ClientContext {
  // The class exposes `listChannels()`, `fetchPricing()`, etc. but not the
  // raw ctx. Re-derive it from the same constructor inputs via type access.
  // (We can't reach private fields, so use the public `name` and rebuild the
  // context — same shape as the class's internal getter.)
  // This relies on knowing the client's config; we instead read the client's
  // private-ish constructor inputs via casting. Acceptable here because the
  // probe module is colocated in the same repo and we control both sides.
  type AnyClient = {
    config: { baseUrl: string; systemAccessToken: string; userId: number };
    _name?: string;
  };
  const c = client as unknown as AnyClient;
  return {
    baseUrl: c.config.baseUrl,
    headers: {
      Authorization: `Bearer ${c.config.systemAccessToken}`,
      "New-Api-User": String(c.config.userId),
      "X-Api-User": String(c.config.userId),
      "Content-Type": "application/json",
    },
    name: c._name ?? "target",
  };
}

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

/**
 * Some upstreams (yun) return a legacy V2 pricing shape with `model_info`
 * carrying tags. The standard `parsePricing` discards those. Re-fetch
 * `/api/pricing` raw and pull the model_info block out so the candidate
 * filter can use tag signals on legacy shapes.
 */
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
      data?: { model_info?: Record<string, { supplier?: string; tags?: string[]; illustrate?: string }> };
    };
    return json?.data?.model_info;
  } catch {
    return undefined;
  }
}
