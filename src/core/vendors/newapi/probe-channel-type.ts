import { consola } from "consola";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import { TIMEOUTS } from "@core/types";
import { getRequestConfig } from "@core/testing/request-configs";
import { testRequest } from "@core/testing/execution";
import type { ModelRequestOpts, TestExchange } from "@core/testing/types";
import { t } from "@server/i18n";

/**
 * The probe's job is to pick between OpenAI / Anthropic / Gemini text-chat
 * shapes. Image/video/audio/embedding endpoints have their own URLs and
 * channel-types via `getTaskModelOverride`, so they don't participate in
 * shape probing — we only ever probe text-classified models.
 */
function isProbeableModel(
  model: string,
  modelEndpoints: Map<string, string[]> | undefined,
): boolean {
  return inferModelType(model, undefined, modelEndpoints) === "text";
}

/**
 * Three "shape" types a reseller can speak. The probe only ever returns
 * one of these; vendor-native channel types like DEEPSEEK / MOONSHOT are
 * upstream-direct and inappropriate for newapi resellers.
 */
const SHAPE_TYPES = {
  OPENAI: CHANNEL_TYPES.OPENAI,
  ANTHROPIC: CHANNEL_TYPES.ANTHROPIC,
  GEMINI: CHANNEL_TYPES.GEMINI,
} as const;

/**
 * Map a vendor key (from `inferVendorFromModelName`) to its native upstream
 * shape. Only `anthropic` and `google` differ from OpenAI; every other
 * vendor's reseller surface is OpenAI-shaped.
 */
function nativeShapeForVendor(vendor: string): number {
  if (vendor === "anthropic") return SHAPE_TYPES.ANTHROPIC;
  if (vendor === "google") return SHAPE_TYPES.GEMINI;
  return SHAPE_TYPES.OPENAI;
}

export interface ProbeOutcome {
  channelType: number;
  shape: "native" | "openai-fallback" | "no-text-models";
}

export interface ProbeOpts {
  baseUrl: string;
  apiKey: string;
  vendor: string;
  models: string[];
  modelEndpoints?: Map<string, string[]>;
  /** Tag used in log output, e.g. "aigc/aigc". */
  logPrefix: string;
  /** Override timeout. Defaults to TIMEOUTS.MODEL_TEST_MS. */
  timeoutMs?: number;
}

/**
 * Probe an upstream reseller to find which shape it accepts for a given
 * vendor's models.
 *
 *   1. Filter to text models. Image/video/audio/embedding never participate
 *      because their channel-type comes from `getTaskModelOverride`.
 *   2. If no text models remain, return shape "no-text-models" with the
 *      vendor's native shape as a placeholder — the channel still gets
 *      created and per-model task overrides decide the real channel-type.
 *   3. Otherwise: try the vendor's native shape first; on failure, fall
 *      back to OpenAI shape (unless native already was OpenAI). If both
 *      fail, return null. The bucket is then skipped — better than creating
 *      a guessed channel that 400s on every request.
 */
export async function probeChannelType(
  opts: ProbeOpts,
): Promise<ProbeOutcome | null> {
  if (opts.models.length === 0) return null;

  const native = nativeShapeForVendor(opts.vendor);
  const textModels = opts.models.filter((m) =>
    isProbeableModel(m, opts.modelEndpoints),
  );
  if (textModels.length === 0) {
    consola.debug(
      t("CORE.PROBE.NO_TEXT_MODELS", {
        prefix: opts.logPrefix,
        vendor: opts.vendor,
      }),
    );
    return { channelType: native, shape: "no-text-models" };
  }

  return runShapeProbe(opts, textModels, native);
}

/**
 * Detect Anthropic's Claude Code "third-party app" billing block — a 4xx
 * response whose body carries the canonical onboarding/credit-claim message
 * Anthropic surfaces when a Claude Code subscription is consumed via a
 * third-party gateway (duck/openclaude-style resellers).
 *
 * The bucket is unusable until the subscription owner claims the credit at
 * claude.ai/settings/usage, but the upstream is otherwise fine. We surface
 * a clearer warning so the operator knows the action item, instead of just
 * "HTTP 400 Bad Request" with no signal. Returns the redacted message text
 * to embed in the warn log, or null when the response doesn't match.
 */
function detectClaudeCodeBillingBlock(
  exchange: TestExchange,
): string | null {
  const body = exchange.response;
  let text = "";
  if (typeof body === "string") {
    text = body;
  } else if (body && typeof body === "object") {
    try {
      text = JSON.stringify(body);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (
    text.includes("Third-party apps now draw from your extra usage") ||
    text.includes("draw from your extra usage, not your plan limits")
  ) {
    return t("CORE.PROBE.BILLING_BLOCK_CLAUDE_CODE");
  }
  return null;
}

async function runShapeProbe(
  opts: ProbeOpts,
  textModels: string[],
  native: number,
): Promise<ProbeOutcome | null> {
  const representative = pickRepresentativeModel(textModels);
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.MODEL_TEST_MS;

  const probeOnce = async (
    channelType: number,
  ): Promise<{
    pass: boolean;
    status?: number;
    error?: string;
    billingBlockReason?: string;
  }> => {
    const reqOpts: ModelRequestOpts = {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: representative,
      channelType,
      useResponsesAPI: false,
    };
    const exchange = await testRequest(getRequestConfig(reqOpts), timeoutMs);
    const billingBlock = exchange.pass
      ? null
      : detectClaudeCodeBillingBlock(exchange);
    return {
      pass: exchange.pass,
      status: exchange.status,
      error: exchange.error,
      billingBlockReason: billingBlock ?? undefined,
    };
  };

  // Retry the probe on failures that look transient (429, 5xx, network
  // errors / timeouts where status is unknown). 4xx other than 429 mean the
  // upstream understood and rejected the shape — retrying won't help and we
  // want to fall through to the OpenAI fallback as fast as possible.
  const tryShape = async (
    channelType: number,
  ): Promise<{
    pass: boolean;
    status?: number;
    error?: string;
    billingBlockReason?: string;
  }> => {
    // 4 attempts over ~43s. Long enough to recover from typical upstream
    // outage blips (503/500/timeout bursts) without bloating sync time too
    // much. Permanently-broken buckets eat the full window before skip;
    // healthy buckets pass attempt 1 and never see the backoff.
    const backoffsMs = [0, 3_000, 10_000, 30_000];
    let last: {
      pass: boolean;
      status?: number;
      error?: string;
      billingBlockReason?: string;
    } = { pass: false };
    for (const delay of backoffsMs) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      last = await probeOnce(channelType);
      if (last.pass) return last;
      // Claude Code third-party billing blocks are not transient — the
      // upstream account needs manual intervention. Skip retries.
      if (last.billingBlockReason) return last;
      const transient =
        last.status === undefined ||
        last.status === 429 ||
        last.status >= 500;
      if (!transient) return last;
      consola.debug(
        t("CORE.PROBE.TRANSIENT_FAILURE", {
          prefix: opts.logPrefix,
          vendor: opts.vendor,
          shape: shapeName(channelType),
          status: last.status ?? "?",
        }),
      );
    }
    return last;
  };

  const nativeResult = await tryShape(native);
  if (nativeResult.pass) {
    consola.debug(
      t("CORE.PROBE.NATIVE_OK", {
        prefix: opts.logPrefix,
        vendor: opts.vendor,
        shape: shapeName(native),
        model: representative,
      }),
    );
    return { channelType: native, shape: "native" };
  }

  consola.debug(
    t("CORE.PROBE.NATIVE_FAILED", {
      prefix: opts.logPrefix,
      vendor: opts.vendor,
      shape: shapeName(native),
      status: nativeResult.status ?? "?",
      error: nativeResult.error ?? "?",
    }),
  );

  // No fallback if native already was OpenAI.
  if (native === SHAPE_TYPES.OPENAI) {
    const blockReason = nativeResult.billingBlockReason;
    consola.warn(
      t("CORE.PROBE.OPENAI_FAILED", {
        prefix: opts.logPrefix,
        vendor: opts.vendor,
        block: blockReason ? ` — ${blockReason}` : "",
      }),
    );
    return null;
  }

  const fallbackResult = await tryShape(SHAPE_TYPES.OPENAI);
  if (fallbackResult.pass) {
    consola.info(
      t("CORE.PROBE.FALLBACK_OPENAI", {
        prefix: opts.logPrefix,
        vendor: opts.vendor,
        shape: shapeName(native),
      }),
    );
    return { channelType: SHAPE_TYPES.OPENAI, shape: "openai-fallback" };
  }

  const blockReason =
    nativeResult.billingBlockReason ?? fallbackResult.billingBlockReason;
  if (blockReason) {
    consola.warn(
      t("CORE.PROBE.SKIPPED_BLOCK", {
        prefix: opts.logPrefix,
        vendor: opts.vendor,
        reason: blockReason,
      }),
    );
  } else {
    consola.warn(
      t("CORE.PROBE.BOTH_FAILED", {
        prefix: opts.logPrefix,
        vendor: opts.vendor,
        native: shapeName(native),
        ns: nativeResult.status ?? "?",
        ne: nativeResult.error ?? "",
        os: fallbackResult.status ?? "?",
        oe: fallbackResult.error ?? "",
      }),
    );
  }
  return null;
}

/**
 * Pick a representative model for probing. We prefer the shortest name
 * because shorter names tend to be canonical/cheaper (e.g. `claude-haiku`
 * over `claude-haiku-4-5-20251001`). No cost data is required.
 */
function pickRepresentativeModel(models: string[]): string {
  return [...models].sort((a, b) => a.length - b.length)[0]!;
}

function shapeName(channelType: number): string {
  if (channelType === SHAPE_TYPES.ANTHROPIC) return "anthropic";
  if (channelType === SHAPE_TYPES.GEMINI) return "gemini";
  if (channelType === SHAPE_TYPES.OPENAI) return "openai";
  return `unknown(${channelType})`;
}
