import { redactExchange, redactUrl } from "@core/testing/redact";
import { saveResponseImages } from "./download";
import type { ProviderConfig } from "@core/validations/config";
import { NewApiClient } from "@core/vendors/newapi/client";
import type { ClientContext } from "@core/vendors/newapi/context";
import { ensureTokens } from "@core/vendors/newapi/tokens";
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
      /** Token keys keyed by group name, populated by ensureTokens. */
      tokensByGroup: Record<string, string>;
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

    // Per-group inference tokens. New-api forbids `/api/channel/` to
    // non-admin keys on most resellers (success:false), so we route via
    // groups instead - each group becomes a distinct routing bucket. The
    // pricing endpoint exposes `enable_groups` per model + a global group
    // list, both publicly readable. ensureTokens creates one token per
    // group with the `image` prefix; matches what `bun sync run` does for
    // its own group tokens, so reuses the same plumbing and so re-running
    // the probe doesn't churn unrelated tokens.
    let tokensByGroup: Record<string, string> = {};
    if (!opts.dryRun) {
      try {
        const ensured = await ensureTokens(
          getCtx(client),
          pricing.groups,
          "image",
        );
        tokensByGroup = ensured.tokens;
        consola.info(
          `[${provider.name}] tokens ready: ${Object.keys(tokensByGroup).length} (created=${ensured.created}, existing=${ensured.existing})`,
        );
      } catch (err) {
        consola.warn(
          t("CORE.IMAGES.NO_INFERENCE_TOKEN", {
            name: provider.name,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
        continue;
      }
      if (Object.keys(tokensByGroup).length === 0) {
        consola.warn(
          t("CORE.IMAGES.NO_INFERENCE_TOKEN", { name: provider.name }),
        );
        continue;
      }
    }

    const groupMap = buildGroupMap(pricing, tokensByGroup);

    candidatesByProvider.set(provider.name, {
      provider,
      client,
      groupMap,
      discovery,
      tokensByGroup,
    });

    if (opts.dryRun) {
      // In dry-run we have no tokens yet, so groupMap is empty. Build a
      // synthetic map from pricing's `enable_groups` so the user still sees
      // every group that would be probed when the run goes live.
      const dryGroupMap = new Map<string, GroupChannel[]>();
      for (const m of pricing.models) {
        const channels: GroupChannel[] = (m.groups ?? []).map((groupName) => ({
          groupName,
          apiKey: "",
        }));
        if (channels.length > 0) dryGroupMap.set(m.name, channels);
      }
      dryRunProviders.push(
        buildDryRunProvider({
          provider,
          totalModels: pricing.models.length,
          totalChannels: pricing.groups.length,
          discovery,
          groupMap: dryGroupMap,
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
      { provider, client, groupMap, discovery },
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

        // Bracket every probe with two balance reads, mirroring regular
        // sync's withCostTracking pattern - users want to see balance
        // movement on every step, including no-cost failures (so they can
        // confirm the upstream actually didn't bill). fetchBalance returns
        // null when the upstream lacks a quota field; in that case we
        // silently skip the cost line for that provider.
        const balanceBefore = await client.fetchBalance();
        const result = await probeOneModel({
          provider,
          candidate: c,
          groupMap,
          fixtures,
          onProgress: saveProgress,
        });
        const balanceAfter = await client.fetchBalance();
        if (balanceBefore !== null && balanceAfter !== null) {
          const delta = balanceBefore - balanceAfter;
          totalSpent += Math.max(0, delta);
          // Stamp the measured cost onto the channel result so it lands in
          // images-results.json. The probe loop only knows the per-MODEL
          // delta, not per-channel - so we attribute the full delta to the
          // winning channel (single billable attempt) or to the last
          // failed-channel entry if no channel passed.
          if (result.workingChannel) result.workingChannel.costUsd = delta;
          else if (result.failedChannels.length > 0) {
            result.failedChannels[result.failedChannels.length - 1]!.costUsd = delta;
          }
          // Always log balance after each step so the user can audit
          // movement in real time. Free probes (delta=0) still produce a
          // line - "$0.0000 | balance: $X.XXXX" confirms the upstream
          // didn't charge.
          const costStr =
            delta < -0.0001
              ? "+$" + Math.abs(delta).toFixed(4) + " (refund?)"
              : "$" + delta.toFixed(4);
          consola.info(
            `[${providerName}] ${c.modelName}: cost ${costStr} | running total: $${totalSpent.toFixed(4)} | balance: $${balanceAfter.toFixed(4)}`,
          );
        }
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
    // Tokens persist across runs (managed by ensureTokens like regular sync).
    // No per-run cleanup needed - re-running picks up the same tokens.
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
  fixtures: Fixtures;
  /** Persist a partial ModelResult after every channel attempt so the
   *  store survives Ctrl-C / network errors mid-loop and resume picks up
   *  with no lost work. */
  onProgress?: (partial: ModelResult) => void;
}): Promise<ModelResult> {
  const { provider, candidate, groupMap, fixtures, onProgress } = opts;
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
  const shapesToTry = probeShapesFor(candidate.endpointTypes, candidate.kind);

  const failed: ChannelResult[] = [];
  for (const g of groups) {
    // Group name is the "channel name" surfaced in results: each group is a
    // distinct routing bucket on new-api with its own bound token.
    const channelName = g.groupName;
    const channelId = 0; // Pricing surface doesn't expose channel ids.

    // Within a group, try each wire shape. Stop on first PASS - if
    // /v1/images/edits worked we don't need to also try /v1/images/generations.
    let channelPassed: ChannelResult | undefined;
    for (const probeShape of shapesToTry) {
      const attempt = await runProbeShape(probeShape, {
        baseUrl: provider.baseUrl,
        apiKey: g.apiKey,
        userId: provider.userId,
        channelId,
        model: candidate.modelName,
        fixtures,
      });

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
        attemptedAt: new Date().toISOString(),
        taskId: attempt.taskId,
      };

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
 * Derive the full list of wire shapes to test for a candidate. When a model
 * advertises multiple endpoint types (e.g. yun's gpt-image-2 has both
 * `openai编辑图片` AND `image-generation`), each shape gets its own attempt:
 * `/v1/images/edits` (sync-edits, multipart) AND `/v1/images/generations`
 * (sync-generations, JSON). User-visible ground truth per endpoint.
 *
 * Always at least one shape: derived from the candidate's primary `kind`
 * when endpointTypes are missing/non-standard.
 */
function probeShapesFor(
  endpointTypes: string[],
  primary: ProbeKind,
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
