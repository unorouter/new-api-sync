import { consola } from "consola";
import {
  CHANNEL_TYPES,
  TIMEOUTS,
  inferModelType,
} from "@core/models/constants";
import { getRequestConfig } from "@core/models/testing/request-configs";
import { testRequest } from "@core/models/testing/execution";
import type { ModelRequestOpts } from "@core/models/testing/types";

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
      `[${opts.logPrefix}/probe] vendor=${opts.vendor} has no text models; ` +
        `skipping shape probe (per-model task overrides will decide channel-type)`,
    );
    return { channelType: native, shape: "no-text-models" };
  }

  const representative = pickRepresentativeModel(textModels);
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.MODEL_TEST_MS;

  const probeOnce = async (
    channelType: number,
  ): Promise<{ pass: boolean; status?: number; error?: string }> => {
    const reqOpts: ModelRequestOpts = {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: representative,
      channelType,
      useResponsesAPI: false,
    };
    const exchange = await testRequest(getRequestConfig(reqOpts), timeoutMs);
    return {
      pass: exchange.pass,
      status: exchange.status,
      error: exchange.error,
    };
  };

  // Retry the probe on failures that look transient (429, 5xx, network
  // errors / timeouts where status is unknown). 4xx other than 429 mean the
  // upstream understood and rejected the shape — retrying won't help and we
  // want to fall through to the OpenAI fallback as fast as possible.
  const tryShape = async (
    channelType: number,
  ): Promise<{ pass: boolean; status?: number; error?: string }> => {
    const backoffsMs = [0, 5_000, 10_000];
    let last: { pass: boolean; status?: number; error?: string } = {
      pass: false,
    };
    for (const delay of backoffsMs) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      last = await probeOnce(channelType);
      if (last.pass) return last;
      const transient =
        last.status === undefined ||
        last.status === 429 ||
        last.status >= 500;
      if (!transient) return last;
      consola.debug(
        `[${opts.logPrefix}/probe] vendor=${opts.vendor} shape=${shapeName(channelType)} ` +
          `transient failure (status=${last.status ?? "?"}); will retry after backoff`,
      );
    }
    return last;
  };

  const nativeResult = await tryShape(native);
  if (nativeResult.pass) {
    consola.debug(
      `[${opts.logPrefix}/probe] vendor=${opts.vendor} native shape ${shapeName(native)} OK (model=${representative})`,
    );
    return { channelType: native, shape: "native" };
  }

  consola.debug(
    `[${opts.logPrefix}/probe] vendor=${opts.vendor} native shape ${shapeName(native)} FAILED ` +
      `(status=${nativeResult.status ?? "?"}, error=${nativeResult.error ?? "?"})`,
  );

  // No fallback if native already was OpenAI.
  if (native === SHAPE_TYPES.OPENAI) {
    consola.warn(
      `[${opts.logPrefix}/probe] vendor=${opts.vendor} OpenAI shape failed; ` +
        `bucket will be skipped`,
    );
    return null;
  }

  const fallbackResult = await tryShape(SHAPE_TYPES.OPENAI);
  if (fallbackResult.pass) {
    consola.info(
      `[${opts.logPrefix}/probe] vendor=${opts.vendor} falling back to OpenAI shape ` +
        `(native ${shapeName(native)} rejected by upstream)`,
    );
    return { channelType: SHAPE_TYPES.OPENAI, shape: "openai-fallback" };
  }

  consola.warn(
    `[${opts.logPrefix}/probe] vendor=${opts.vendor} both native (${shapeName(native)}) and OpenAI ` +
      `shapes failed; bucket will be skipped ` +
      `(native: status=${nativeResult.status ?? "?"} ${nativeResult.error ?? ""}; ` +
      `openai: status=${fallbackResult.status ?? "?"} ${fallbackResult.error ?? ""})`,
  );
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
