import { redactExchange } from "@core/testing/redact";
import type { ProviderConfig } from "@core/validations/config";
import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { Candidate } from "./candidates";
import { extractMaxImagesFromRejection } from "./classify";
import { saveResponseImages } from "./download";
import { withFixtureCount, type Fixtures } from "./fixtures";
import { compareGroupChannels, type GroupChannel } from "./group-map";
import {
  isGatewayBrokenSignature,
  probeStepsFor,
  shapeHasImageInputs,
  shapeToKind,
} from "./planner";
import { probeGenerationsChannel } from "./probe-generations";
import { probeOpenAiVendorChannel } from "./probe-openai-image-edit";
import type { ProbeAttempt } from "./probe-sync";
import { probeSyncChannel } from "./probe-sync";
import { probeTaskChannel } from "./probe-task";
import {
  artifactDirFor,
  slug,
  writeArtifact,
  type ChannelResult,
  type ModelResult,
  type ProbeShape,
} from "./store";
import type { ProbeTokenManager } from "./token-manager";

export async function probeOneModel(opts: {
  provider: ProviderConfig;
  candidate: Candidate;
  groupMap: Map<string, GroupChannel[]>;
  tokens: ProbeTokenManager;
  pricing: UpstreamPricing;
  fixtures: Fixtures;
  /** Provider-scoped: 403-dead groups shared across models. */
  deadGroups: Set<string>;
  /** Provider-scoped: set once on first passing probe. */
  asyncBillingState: {
    get: () => "unknown" | boolean;
    set: (v: boolean) => void;
  };
  /** Crash-resume persistence. */
  onProgress?: (partial: ModelResult) => void;
  /** null = no quota exposed. */
  fetchBalance?: () => Promise<number | null>;
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
      // 429 retry only; non-429 passes through to avoid double-billing refusals.
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
      // Image-count downshift: one retry with trimmed fixtures.
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
      // Async-billing settle (yun debits ~20s after): unknown→20s autodetect, true→60s, false→skip.
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

      // Save bytes for fail too (heuristic might miss). Non-redacted response: data: URIs survive.
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
      // 403 hits every remaining model on this group.
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
        // Inline so master file stands alone (mirrors failedChannels[]).
        workingChannel: channelPassed,
        failedChannels: failed,
        decidedAt: new Date().toISOString(),
      };
      onProgress?.(decided);
      return decided;
    }

    // Gateway routing is global; one body-translator signature = skip remaining groups.
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
    /** Override (Replicate, Tencent VOD); undefined → probe default. */
    path?: string;
  },
): Promise<ProbeAttempt> {
  if (shape === "sync-edits") return probeSyncChannel(opts);
  if (shape === "sync-generations") return probeGenerationsChannel(opts);
  if (shape === "openai-vendor") return probeOpenAiVendorChannel(opts);
  return probeTaskChannel(opts);
}
