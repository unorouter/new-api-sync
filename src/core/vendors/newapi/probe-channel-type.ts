import { consola } from "consola";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { inferModelType } from "@core/catalog/constants/inference";
import { TIMEOUTS } from "@core/types";
import { getRequestConfig } from "@core/testing/request-configs";
import { testRequest } from "@core/testing/execution";
import type { ModelRequestOpts, TestExchange } from "@core/testing/types";
import { t } from "@server/i18n";

const SHAPE_TYPES = {
  OPENAI: CHANNEL_TYPES.OPENAI,
  ANTHROPIC: CHANNEL_TYPES.ANTHROPIC,
  GEMINI: CHANNEL_TYPES.GEMINI,
} as const;

const SHAPE_NAMES: Record<number, string> = {
  [SHAPE_TYPES.ANTHROPIC]: "anthropic",
  [SHAPE_TYPES.GEMINI]: "gemini",
  [SHAPE_TYPES.OPENAI]: "openai",
};
const shapeName = (ct: number) => SHAPE_NAMES[ct] ?? `unknown(${ct})`;

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
  logPrefix: string;
  timeoutMs?: number;
}

export async function probeChannelType(
  opts: ProbeOpts,
): Promise<ProbeOutcome | null> {
  if (opts.models.length === 0) return null;

  const native = nativeShapeForVendor(opts.vendor);
  const textModels = opts.models.filter(
    (m) => inferModelType(m, undefined, opts.modelEndpoints) === "text",
  );
  if (textModels.length === 0)
    return { channelType: native, shape: "no-text-models" };

  return runShapeProbe(opts, textModels, native);
}

function detectClaudeCodeBillingBlock(exchange: TestExchange): string | null {
  const body = exchange.response;
  let text = "";
  if (typeof body === "string") text = body;
  else if (body && typeof body === "object") {
    try {
      text = JSON.stringify(body);
    } catch {
      return null;
    }
  } else return null;
  if (
    text.includes("Third-party apps now draw from your extra usage") ||
    text.includes("draw from your extra usage, not your plan limits")
  )
    return t("CORE.PROBE.BILLING_BLOCK_CLAUDE_CODE");
  return null;
}

interface ShapeResult {
  pass: boolean;
  status?: number;
  error?: string;
  billingBlockReason?: string;
}

async function runShapeProbe(
  opts: ProbeOpts,
  textModels: string[],
  native: number,
): Promise<ProbeOutcome | null> {
  const representative = [...textModels].sort(
    (a, b) => a.length - b.length,
  )[0]!;
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.MODEL_TEST_MS;
  const { logPrefix: prefix, vendor } = opts;

  const probeOnce = async (channelType: number): Promise<ShapeResult> => {
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
      billingBlockReason: exchange.pass
        ? undefined
        : (detectClaudeCodeBillingBlock(exchange) ?? undefined),
    };
  };

  const tryShape = async (channelType: number): Promise<ShapeResult> => {
    let last: ShapeResult = { pass: false };
    for (const delay of [0, 3_000, 10_000, 30_000]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      last = await probeOnce(channelType);
      if (last.pass) return last;
      if (last.billingBlockReason) return last;
      const transient =
        last.status === undefined || last.status === 429 || last.status >= 500;
      if (!transient) return last;
    }
    return last;
  };

  const nativeResult = await tryShape(native);
  if (nativeResult.pass) return { channelType: native, shape: "native" };

  if (native === SHAPE_TYPES.OPENAI) {
    const blockReason = nativeResult.billingBlockReason;
    consola.warn(
      t("CORE.PROBE.OPENAI_FAILED", {
        prefix,
        vendor,
        block: blockReason ? ` - ${blockReason}` : "",
      }),
    );
    return null;
  }

  const fallbackResult = await tryShape(SHAPE_TYPES.OPENAI);
  if (fallbackResult.pass) {
    consola.info(
      t("CORE.PROBE.FALLBACK_OPENAI", {
        prefix,
        vendor,
        shape: shapeName(native),
      }),
    );
    return { channelType: SHAPE_TYPES.OPENAI, shape: "openai-fallback" };
  }

  const blockReason =
    nativeResult.billingBlockReason ?? fallbackResult.billingBlockReason;
  if (blockReason) {
    consola.warn(
      t("CORE.PROBE.SKIPPED_BLOCK", { prefix, vendor, reason: blockReason }),
    );
  } else {
    consola.warn(
      t("CORE.PROBE.BOTH_FAILED", {
        prefix,
        vendor,
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
