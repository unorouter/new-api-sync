import { throwIfRunAborted } from "@core/infra/abort";
import { redactExchange } from "@core/testing/redact";
import type { ProviderConfig } from "@core/validations/config";
import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { Candidate } from "./candidates";
import { extractMaxImagesFromRejection } from "../classify";
import { saveResponseImages } from "../io/download";
import { withFixtureCount, type Fixtures } from "../io/fixtures";
import { compareGroupChannels, type GroupChannel } from "../group-map";
import {
  isGatewayBrokenSignature,
  probeStepsFor,
  shapeHasImageInputs,
  shapeToKind,
} from "./planner";
import {
  probeGenerationsChannel,
  probeOpenAiVendorChannel,
  probeSyncChannel,
  type ProbeAttempt,
} from "../runners/probe";
import { probeTaskChannel } from "../runners/probe-task";
import {
  artifactDirFor,
  slug,
  writeArtifact,
  type ChannelResult,
  type ModelResult,
  type ProbeShape,
} from "../io/store";
import type { ProbeTokenManager } from "../token-manager";

type ProbeRunOpts = {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  path?: string;
};

const PROBE_DISPATCH: Record<
  ProbeShape,
  (o: ProbeRunOpts) => Promise<ProbeAttempt>
> = {
  "sync-edits": probeSyncChannel,
  "sync-generations": probeGenerationsChannel,
  "openai-vendor": probeOpenAiVendorChannel,
  task: probeTaskChannel,
};

const runProbeShape = (shape: ProbeShape, o: ProbeRunOpts) =>
  PROBE_DISPATCH[shape](o);

export async function probeOneModel(opts: {
  provider: ProviderConfig;
  candidate: Candidate;
  groupMap: Map<string, GroupChannel[]>;
  tokens: ProbeTokenManager;
  pricing: UpstreamPricing;
  fixtures: Fixtures;
  deadGroups: Set<string>;
  asyncBillingState: {
    get: () => "unknown" | boolean;
    set: (v: boolean) => void;
  };
  onProgress?: (partial: ModelResult) => void;
  fetchBalance?: () => Promise<number | null>;
  onStepCost?: (info: {
    channelName: string;
    probeShape: ProbeShape;
    delta: number;
    balanceAfter: number;
  }) => void;
}): Promise<ModelResult> {
  const { provider, candidate, fixtures, deadGroups, asyncBillingState } = opts;
  const { onProgress, fetchBalance, onStepCost } = opts;
  const groups = (opts.groupMap.get(candidate.modelName) ?? [])
    .slice()
    .sort(compareGroupChannels);
  const baseResult = (failedChannels: ChannelResult[]): ModelResult => ({
    provider: provider.name,
    model: candidate.modelName,
    kind: candidate.kind,
    failedChannels,
    decidedAt: new Date().toISOString(),
  });
  if (groups.length === 0) return baseResult([]);

  const stepsToTry = probeStepsFor({
    endpointTypes: candidate.endpointTypes,
    primary: candidate.kind,
    modelName: candidate.modelName,
    pricing: opts.pricing,
  });
  const prefix = `[${provider.name}] ${candidate.modelName}`;
  consola.info(
    `${prefix}: ${groups.length} group(s), cheapest-first: ${groups.map((g) => `${g.groupName}(x${g.groupRatio})`).join(", ")}`,
  );

  const fetchBalanceTimed = fetchBalance
    ? () =>
        Promise.race([
          fetchBalance(),
          new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
        ])
    : undefined;
  const getBalance = () => (fetchBalanceTimed ? fetchBalanceTimed() : null);

  const failed: ChannelResult[] = [];
  for (const g of groups) {
    const channelName = g.groupName;
    if (deadGroups.has(channelName)) {
      consola.info(`${prefix} (${channelName}): skipping (auth-dead group)`);
      continue;
    }
    const apiKey = await opts.tokens.getApiKey(channelName);
    if (!apiKey) {
      consola.warn(
        `${prefix} (${channelName}): could not resolve api key, skipping group`,
      );
      continue;
    }

    let channelPassed: ChannelResult | undefined;
    for (const step of stepsToTry) {
      const probeShape = step.shape;
      const mkArgs = (fx: Fixtures): ProbeRunOpts => ({
        baseUrl: provider.baseUrl,
        apiKey,
        userId: provider.userId,
        model: candidate.modelName,
        fixtures: fx,
        path: step.path,
      });
      const tag = `${prefix} (${channelName}/${probeShape})`;
      const balanceBefore = await getBalance();
      let attempt = await runProbeShape(probeShape, mkArgs(fixtures));
      for (let r = 0; attempt.errorClass === "ratelimit" && r < 3; r++) {
        const wait = 5000 * 2 ** r;
        consola.warn(
          `${tag}: rate-limited, retry in ${wait / 1000}s (${r + 1}/3)`,
        );
        await new Promise((rs) => setTimeout(rs, wait));
        attempt = await runProbeShape(probeShape, mkArgs(fixtures));
      }
      if (attempt.status === "fail") {
        const resp = attempt.exchange.response;
        const bodyText =
          resp == null
            ? ""
            : typeof resp === "string"
              ? resp
              : JSON.stringify(resp);
        const maxImgs = extractMaxImagesFromRejection(bodyText);
        if (
          maxImgs !== null &&
          maxImgs < fixtures.dataUris.length &&
          maxImgs >= 1
        ) {
          consola.warn(
            `${tag}: upstream caps refs at ${maxImgs}, retrying with ${maxImgs} images`,
          );
          attempt = await runProbeShape(
            probeShape,
            mkArgs(withFixtureCount(fixtures, maxImgs)),
          );
        }
      }

      let balanceAfter = await getBalance();
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
        if (billing !== false) {
          const probed = await pollSettle({
            balanceBefore: balanceBefore!,
            fetchBalance: fetchBalanceTimed!,
            budgetMs: billing === true ? 60_000 : 20_000,
            initialAfter: balanceAfter,
            initialDelta: stepDelta,
          });
          balanceAfter = probed.balanceAfter;
          stepDelta = probed.stepDelta;
          if (billing === "unknown")
            asyncBillingState.set(
              stepDelta !== undefined && Math.abs(stepDelta) >= 0.0001,
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
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const savedImages = await saveResponseImages({
        response: attempt.exchange.response,
        dir: artifactDirFor(provider.name, candidate.modelName),
        basenamePrefix: `${ts}-${slug(channelName)}-${probeShape}`,
      });
      const hasImgs = savedImages.length > 0;
      const cr: ChannelResult = {
        channelName,
        exchange: redacted,
        errorClass: attempt.errorClass,
        artifactPath,
        imagePaths: hasImgs ? savedImages.map((s) => s.path) : undefined,
        imageResolutions: hasImgs
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
      if (stepDelta !== undefined && balanceAfter !== null)
        onStepCost?.({
          channelName,
          probeShape,
          delta: stepDelta,
          balanceAfter,
        });
      if (attempt.status === "ok") {
        channelPassed = cr;
        break;
      }
      failed.push(cr);
      if (attempt.errorClass === "auth") {
        deadGroups.add(channelName);
        consola.warn(
          `${prefix} (${channelName}): auth 403, marking group dead for rest of run`,
        );
        onProgress?.(baseResult(failed));
        break;
      }
      onProgress?.(baseResult(failed));
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
        ...baseResult(failed),
        workingChannelName: channelName,
        workingChannel: channelPassed,
      };
      onProgress?.(decided);
      return decided;
    }
    const channelAttempts = failed.slice(-stepsToTry.length);
    if (channelAttempts.some((a) => isGatewayBrokenSignature(a))) {
      consola.warn(
        `${prefix}: gateway-broken body signature on ${channelName} (translator can't route this model), skipping remaining groups`,
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
  return baseResult(failed);
}

async function pollSettle(opts: {
  balanceBefore: number;
  fetchBalance: () => Promise<number | null>;
  budgetMs: number;
  initialAfter: number | null;
  initialDelta: number | undefined;
}): Promise<{ balanceAfter: number | null; stepDelta: number | undefined }> {
  let balanceAfter = opts.initialAfter;
  let stepDelta = opts.initialDelta;
  const deadline = Date.now() + opts.budgetMs;
  while (Date.now() < deadline) {
    throwIfRunAborted();
    await new Promise((r) => setTimeout(r, 2000));
    const b = await opts.fetchBalance();
    if (b !== null && Math.abs(opts.balanceBefore - b) >= 0.0001) {
      balanceAfter = b;
      stepDelta = opts.balanceBefore - b;
      break;
    }
  }
  return { balanceAfter, stepDelta };
}
