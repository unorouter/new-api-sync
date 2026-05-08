import { redactExchange } from "@core/testing/redact";
import { saveResponseImages } from "./download";
import type { Channel, GroupInfo } from "@core/types";
import type { ProviderConfig } from "@core/validations/config";
import { NewApiClient } from "@core/vendors/newapi/client";
import type { ClientContext } from "@core/vendors/newapi/context";
import {
  createToken,
  deleteToken,
  getTokenFullKey,
  listTokens,
} from "@core/vendors/newapi/tokens";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { RuntimeConfig } from "@core/config";
import {
  discoverCandidates,
  type Candidate,
  type DiscoveryReport,
} from "./candidates";
import {
  buildChannelMap,
  compareChannelsForProbe,
} from "./channel-map";
import { loadFixtures, type Fixtures } from "./fixtures";
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
      ctx: ClientContext;
      client: NewApiClient;
      channelMap: Map<string, Channel[]>;
      discovery: DiscoveryReport;
      inferenceApiKey: string;
      /** Probe-scoped token id; deleted in the finally block. */
      probeTokenId: number;
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

    let channelMap: Map<string, Channel[]>;
    try {
      channelMap = await buildChannelMap(getCtx(client));
    } catch (err) {
      // Most resellers refuse /api/channel/ to non-admins ("insufficient
      // privileges"). Fall back to a synthetic single-channel map so we
      // can still probe each candidate once via normal routing (no
      // Specify-Channel pin). The "channel" recorded in results will be
      // a placeholder labelled `auto` with id 0.
      consola.warn(
        t("CORE.IMAGES.CHANNEL_LIST_FAILED", {
          name: provider.name,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      consola.info(
        t("CORE.IMAGES.CHANNEL_LIST_FALLBACK", { name: provider.name }),
      );
      channelMap = buildSyntheticChannelMap(pricing.models.map((m) => m.name));
    }

    // Acquire a per-user inference API key. The systemAccessToken is admin
    // bearer for /api/channel/, /api/token/, etc. - but new-api rejects it
    // for /v1/chat/completions and /v1/images/edits. We create a fresh,
    // probe-scoped token (name `image-probe-<providerName>`) bound to the
    // broadest available group, use it for the run, and delete it in the
    // finally block below. This keeps probe runs idempotent and never
    // touches the user's hand-managed or sync-managed tokens.
    const acquired = opts.dryRun
      ? null
      : await acquireProbeToken(getCtx(client), provider.name, pricing.groups);
    if (!acquired && !opts.dryRun) {
      consola.warn(
        t("CORE.IMAGES.NO_INFERENCE_TOKEN", { name: provider.name }),
      );
      continue;
    }

    candidatesByProvider.set(provider.name, {
      provider,
      ctx: getCtx(client),
      client,
      channelMap,
      discovery,
      inferenceApiKey: acquired?.key ?? "",
      probeTokenId: acquired?.tokenId ?? 0,
    });

    if (opts.dryRun) {
      dryRunProviders.push(
        buildDryRunProvider({
          provider,
          totalModels: pricing.models.length,
          totalChannels: countActiveChannels(channelMap),
          discovery,
          channelMap,
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
      { provider, client, channelMap, discovery, inferenceApiKey },
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

        // Bracket the probe with two balance reads so we can show the user
        // the actual USD-equivalent spend per attempt. fetchBalance returns
        // null when the upstream lacks an /api/user/self quota field; in
        // that case we silently skip the cost line for that provider.
        const balanceBefore = await client.fetchBalance();
        const result = await probeOneModel({
          provider,
          apiKey: inferenceApiKey,
          candidate: c,
          channelMap,
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
          if (delta > 0.0001 || result.workingChannelId !== undefined) {
            consola.info(
              `[${providerName}] ${c.modelName}: cost ${delta < 0 ? "+$" + Math.abs(delta).toFixed(4) + " (refund?)" : "$" + delta.toFixed(4)} | running total: $${totalSpent.toFixed(4)} | balance: $${balanceAfter.toFixed(4)}`,
            );
          }
        }
        appendResult(store, result);
        saveStore(store);
        if (result.workingChannelId !== undefined) passed++;
        else if (result.failedChannels.length === 0) noChannel++;
        else failed++;
      }
    }
    if (aborted) {
      // Fall through to cleanup + summary so the user sees what they got.
    }
  } finally {
    await cleanupProbeTokens(candidatesByProvider);
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
  apiKey: string;
  candidate: Candidate;
  channelMap: Map<string, Channel[]>;
  fixtures: Fixtures;
  /** Persist a partial ModelResult after every channel attempt so the
   *  store survives Ctrl-C / network errors mid-loop and resume picks up
   *  with no lost work. */
  onProgress?: (partial: ModelResult) => void;
}): Promise<ModelResult> {
  const { provider, apiKey, candidate, channelMap, fixtures, onProgress } = opts;
  const channels = (channelMap.get(candidate.modelName) ?? [])
    .slice()
    .sort(compareChannelsForProbe);

  if (channels.length === 0) {
    return {
      provider: provider.name,
      model: candidate.modelName,
      kind: candidate.kind,
      failedChannels: [],
      decidedAt: new Date().toISOString(),
    };
  }

  // Derive every probe kind the model's endpoint_types support. Models
  // with both `image-generation` AND `dall-e-3` (or both `openai` AND
  // `image-generation`) get one attempt per kind so we capture how each
  // wire shape behaves. Errors don't bill so probing extra kinds is free.
  const kindsToTry = probeKindsFor(candidate.endpointTypes, candidate.kind);

  const failed: ChannelResult[] = [];
  for (const ch of channels) {
    const channelId = ch.id ?? 0;
    const channelName = ch.name ?? `channel-${channelId}`;

    // Within a channel, try each wire shape. Stop on first PASS - if
    // /v1/images/edits worked we don't need to also try chat-completions.
    let channelPassed: ChannelResult | undefined;
    for (const probeKind of kindsToTry) {
      const attempt = await runProbe(probeKind, {
        baseUrl: provider.baseUrl,
        apiKey,
        userId: provider.userId,
        channelId,
        model: candidate.modelName,
        fixtures,
      });

      const redacted = redactExchange(attempt.exchange);
      const artifactPath = writeArtifact(
        provider.name,
        candidate.modelName,
        channelId,
        redacted,
      );

      // Save the actual generated image bytes (URL download or base64 decode)
      // to disk before the upstream CDN URL expires. Run for both pass and
      // fail attempts: a failed-classification probe (e.g. our heuristic
      // didn't see an image, but the body still has one) is exactly the
      // case we want bytes for, to inspect what the model actually
      // produced. We pass the ORIGINAL response, not the redacted one -
      // the redactor could in theory mangle data: URIs.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const imagePaths = await saveResponseImages({
        response: attempt.exchange.response,
        dir: artifactDirFor(provider.name, candidate.modelName),
        basenamePrefix: `${ts}-ch${channelId}-${probeKind}`,
      });

      const cr: ChannelResult = {
        channelId,
        channelName,
        exchange: redacted,
        errorClass: attempt.errorClass,
        artifactPath,
        imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
        probeKind,
        attemptedAt: new Date().toISOString(),
        taskId: attempt.taskId,
      };

      if (attempt.status === "ok") {
        channelPassed = cr;
        break;
      }
      failed.push(cr);
      // Persist mid-loop so a crash on the next kind doesn't lose the
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

function runProbe(
  kind: ProbeKind,
  opts: {
    baseUrl: string;
    apiKey: string;
    userId: number;
    channelId: number;
    model: string;
    fixtures: Fixtures;
  },
): Promise<ProbeAttempt> {
  if (kind === "sync") return probeSyncChannel(opts);
  if (kind === "openai-vendor") return probeOpenAiVendorChannel(opts);
  return probeTaskChannel(opts);
}

/**
 * Derive the full list of probe kinds to test for a candidate. When a model
 * advertises multiple wire shapes (e.g. yun's gpt-image-2 has both
 * `["openai编辑图片", "image-generation"]`, or another has both
 * `["image-generation", "dall-e-3"]`), test each one and record per-kind
 * results. The user gets ground truth on which wire shapes actually work.
 *
 * Always at least one kind: the candidate's primary `kind` from discovery.
 */
function probeKindsFor(endpointTypes: string[], primary: ProbeKind): ProbeKind[] {
  const kinds = new Set<ProbeKind>([primary]);
  // Multipart edit endpoints map to "sync"
  for (const e of endpointTypes) {
    const lower = e.toLowerCase();
    if (
      lower === "image-generation" ||
      lower === "openai-image" ||
      lower === "image-edit" ||
      lower === "aigc-image" ||
      lower === "aigc-image-edit" ||
      lower.includes("编辑图片")
    ) {
      kinds.add("sync");
    } else if (lower === "openai" || lower === "anthropic") {
      kinds.add("openai-vendor");
    } else if (lower === "openai-video" || lower === "omni-video") {
      // We currently exclude pure-video at discovery. If a model has both
      // image AND video endpoints we keep only the image side - don't probe
      // the video shape because it requires submit+poll and our 6-ref
      // probe semantics don't translate.
    } else if (lower === "dall-e-3") {
      // dall-e-3 wire is text-to-image. Map to "sync" since
      // probeSyncChannel hits /v1/images/edits which is the closest
      // wire-compatible shape; the 6 multipart `image[]` parts will be
      // rejected by upstream and we'll record the rejection. (We don't
      // have a separate dall-e-3 generations probe path.)
      kinds.add("sync");
    }
  }
  return [...kinds];
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

/**
 * Synthesize a one-channel map when `/api/channel/` is forbidden (most
 * reseller new-api instances). The probe loop hits each model exactly once
 * via the upstream's normal routing — channel id 0 is the sentinel for
 * "auto-routed, no Specify-Channel pin".
 */
function buildSyntheticChannelMap(modelNames: string[]): Map<string, Channel[]> {
  const map = new Map<string, Channel[]>();
  const synthetic: Channel = {
    id: 0,
    name: "auto",
    type: 0,
    key: "",
    base_url: "",
    models: "",
    group: "",
    priority: 0,
    weight: 0,
    status: 1,
  };
  for (const m of modelNames) map.set(m, [synthetic]);
  return map;
}

function countActiveChannels(channelMap: Map<string, Channel[]>): number {
  const seen = new Set<number>();
  for (const arr of channelMap.values()) {
    for (const ch of arr) {
      if (ch.status === 1 && ch.id !== undefined) seen.add(ch.id);
    }
  }
  return seen.size;
}

function buildDryRunProvider(opts: {
  provider: ProviderConfig;
  totalModels: number;
  totalChannels: number;
  discovery: DiscoveryReport;
  channelMap: Map<string, Channel[]>;
}): DryRunProvider {
  const { provider, totalModels, totalChannels, discovery, channelMap } = opts;
  const candidates: DryRunCandidate[] = discovery.candidates.map((c) => {
    const chs = (channelMap.get(c.modelName) ?? [])
      .slice()
      .sort(compareChannelsForProbe);
    return {
      model: c.modelName,
      canonicalKey: c.canonicalKey,
      aliases: c.aliases,
      kind: c.kind,
      endpointTypes: c.endpointTypes,
      tags: c.tags,
      vendorId: c.vendorId,
      channels: chs.map((ch) => ({
        id: ch.id ?? 0,
        name: ch.name ?? "",
        priority: ch.priority ?? 0,
        weight: ch.weight ?? 0,
      })),
      reasons: c.reasons,
    };
  });
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    totalModels,
    totalChannels,
    candidates,
    excluded: discovery.excluded.map((e) => ({
      model: e.modelName,
      reason: e.reason,
    })),
  };
}

const PROBE_TOKEN_PREFIX = "image";

/** Token name used for the probe. Stable per-provider so reruns reuse it. */
function probeTokenName(providerName: string): string {
  // Mirrors ensureTokens' `{groupName}-{prefix}` pattern but with a fixed
  // probe prefix. Keeps the 30-byte name limit intact for any sane provider
  // name; truncation isn't needed because providerName is user-controlled
  // and short (config.yml provider keys are typically <16 chars).
  return `${providerName}-${PROBE_TOKEN_PREFIX}`;
}

/**
 * Pick the broadest group from the provider's `/api/pricing` response. The
 * probe submits a wide variety of image-edit models, so we want the group
 * with the largest model list. Falls back to ranked names when no group
 * data is available (legacy yun shape sometimes returns empty groups[]).
 */
function pickBroadestGroup(groups: GroupInfo[]): string {
  if (groups.length === 0) return "default";
  const ranked = [...groups].sort((a, b) => {
    const ma = a.models?.length ?? 0;
    const mb = b.models?.length ?? 0;
    if (ma !== mb) return mb - ma;
    // Tiebreaker: prefer well-known broad-group names.
    const score = (n: string): number => {
      const lower = (n ?? "").toLowerCase();
      if (lower.includes("全模型") || lower.includes("all-model")) return 100;
      if (lower === "default" || lower === "通用大模型") return 50;
      if (lower.includes("vip") || lower.includes("会员")) return 30;
      return 0;
    };
    return score(b.name) - score(a.name);
  });
  return ranked[0]?.name ?? "default";
}

/**
 * Ensure a probe-scoped token exists on the upstream and return its full
 * key + id. The token name is `{providerName}-image` and lives in the
 * broadest available group. If a stale token from a prior aborted run is
 * found, it is deleted and recreated so quota / group settings stay fresh.
 *
 * The token id is plumbed back to the orchestrator so `cleanupProbeTokens`
 * can delete it when the run finishes (or aborts).
 */
async function acquireProbeToken(
  ctx: ClientContext,
  providerName: string,
  groups: GroupInfo[],
): Promise<{ key: string; tokenId: number } | null> {
  const name = probeTokenName(providerName);
  const group = pickBroadestGroup(groups);

  // If a stale probe token from a prior aborted run is still around, delete
  // it so quota / group settings don't drift (e.g. user changed groups
  // in upstream since last run).
  let existing;
  try {
    existing = await listTokens(ctx);
  } catch {
    return null;
  }
  const stale = existing.find((t) => t.name === name);
  if (stale) {
    await deleteToken(ctx, stale.id);
  }

  const created = await createToken(ctx, name, group);
  if (!created) return null;

  // POST /api/token/ doesn't return the new id — re-list to find it.
  let refreshed;
  try {
    refreshed = await listTokens(ctx);
  } catch {
    return null;
  }
  const tok = refreshed.find((t) => t.name === name);
  if (!tok) return null;

  let key = tok.key;
  if (key.includes("**")) {
    const fetched = await getTokenFullKey(ctx, tok.id);
    if (!fetched) {
      // Created but key unrecoverable; clean up.
      await deleteToken(ctx, tok.id).catch(() => {});
      return null;
    }
    key = fetched;
  }
  if (!key) {
    await deleteToken(ctx, tok.id).catch(() => {});
    return null;
  }
  return {
    key: key.startsWith("sk-") ? key : `sk-${key}`,
    tokenId: tok.id,
  };
}

/**
 * Delete every probe-scoped token created during the run. Called from the
 * orchestrator's `finally` block so tokens get cleaned up even on errors
 * or Ctrl-C. Failures are logged but don't throw — leftover probe tokens
 * are picked up and recreated on the next run anyway.
 */
async function cleanupProbeTokens(
  byProvider: Map<
    string,
    { ctx: ClientContext; probeTokenId: number }
  >,
): Promise<void> {
  for (const [providerName, entry] of byProvider) {
    if (!entry.probeTokenId) continue;
    try {
      const ok = await deleteToken(entry.ctx, entry.probeTokenId);
      if (!ok) {
        consola.warn(
          t("CORE.IMAGES.PROBE_TOKEN_DELETE_FAILED", { name: providerName }),
        );
      }
    } catch (err) {
      consola.warn(
        t("CORE.IMAGES.PROBE_TOKEN_DELETE_FAILED", {
          name: providerName,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
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
