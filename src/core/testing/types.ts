import type { EntityChangeSet } from "@core/types";

export interface TestExchange {
  pass: boolean;
  request: { url: string; headers: Record<string, string>; body: unknown };
  response: unknown;
  responseHeaders: Record<string, string>;
  error?: string;
  status?: number;
  latencyMs?: number;
}

export interface AuthenticityProbeLog {
  probe: string;
  pass: boolean;
  authenticityRefusal: boolean;
  request: { url: string; body: unknown };
  response: string | null;
  error?: string;
}

export interface ModelTestLog {
  provider: string;
  model: string;
  cost: number | null;
  http: TestExchange;
  stream: TestExchange | null;
  toolCall: TestExchange | null;
  authentic: boolean | null;
  authenticityProbes?: AuthenticityProbeLog[];
}

export interface ProviderCostEntry {
  /** Net balance delta (start - end) for the provider during this run. */
  testCost?: number;
  /** Pipeline outcome for this provider, if a sync ran. */
  success?: boolean;
  /** Pipeline error message, if the provider failed. */
  error?: string;
  /** Applied channel changes scoped to this provider (by Channel.tag). */
  channels?: EntityChangeSet;
  /** Group/model/token counts as reported by the provider pipeline. */
  groups?: number;
  models?: number;
  tokens?: { created: number; existing: number; deleted: number };
}

export interface RunSummary {
  providers: { passed: number; total: number };
  channels: EntityChangeSet;
  models: EntityChangeSet & { orphansDeleted: number };
  options: { updated: string[] };
  elapsedSeconds: number;
  success: boolean;
  errors?: Array<{ phase: string; key: string; message: string }>;
}

/**
 * One vote result per unique exposed model name. The vote (which sources
 * matched, what they returned, which cluster won) is a global property of
 * the model — it doesn't change per (provider, group, vendor) bucket — so
 * we deduplicate to one entry per model rather than logging the same vote
 * 18 times across buckets.
 *
 * The per-bucket drop/keep math derived from this vote is logged inline
 * with `consola.info` and reflected in the working/dropped model counts;
 * it does not need its own structured field.
 */
export interface PricingGateLog {
  exposed: string;
  vote: {
    candidates: Array<{
      source: string;
      matchedKey?: string;
      modelRatio?: number;
      completionRatio?: number;
      /** Human-readable USD per million tokens, derived from modelRatio × 2. */
      inputUsdPerM?: number;
      /** USD per million output tokens, derived from inputUsdPerM × completionRatio. */
      outputUsdPerM?: number;
    }>;
    cluster: {
      members: string[];
      modelRatio: number;
      completionRatio: number;
      inputUsdPerM: number;
      outputUsdPerM: number;
    } | null;
    decision: "voted" | "no-majority" | "no-matches";
  };
}

/**
 * Per-model OpenRouter /endpoints snapshot captured during pricing prefetch.
 * Useful when debugging "why did source openrouter return X for this model?"
 * since the picked endpoint is `max(prompt * (1 - discount))` across rows.
 */
export interface OpenRouterEndpointsLog {
  id: string;
  endpoints: Array<{
    provider: string;
    quantization?: string;
    prompt: number;
    completion: number;
    discount: number;
    effectivePrompt: number;
    effectiveCompletion: number;
  }>;
  picked?: {
    provider: string;
    promptUsd: number;
    completionUsd: number;
  };
}

export interface TestReport {
  timestamp: string;
  /** Per-provider summary keyed by provider config name. Carries balance
   *  delta, pipeline outcome, and per-provider channel diff counts. */
  providers: Record<string, ProviderCostEntry>;
  /** Run-level summary (matches what `printRunSummary` prints to stdout). */
  summary?: RunSummary;
  /** All per-model test logs across the run. Replaces the legacy `results`
   *  field (still accepted on read for back-compat with old report files). */
  modelTests: ModelTestLog[];
  /** Per-(provider/group/vendor/model) pre-test gate decision trace. */
  pricingGate?: PricingGateLog[];
  /** Per-OpenRouter-model /endpoints raw rows + the picked canonical row. */
  openrouterEndpoints?: OpenRouterEndpointsLog[];
}

export interface RequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  isSuccess: (data: unknown) => boolean;
}

export interface StreamRequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  completionMarker: string;
}

export interface ToolCallRequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  isToolCallSuccess: (data: unknown) => boolean;
}

export interface ModelRequestOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  channelType: number;
  useResponsesAPI: boolean;
}

export interface RawResult {
  status: number | null;
  data: unknown;
  bodyText: string | null;
  error: string | null;
  latencyMs: number;
  responseHeaders: Record<string, string>;
}

export interface ModelTestDetail {
  model: string;
  success: boolean;
  streamSuccess: boolean | null;
  toolCallSuccess: boolean | null;
  authenticityProbed: boolean;
  httpStatus?: number;
  // The CHANNEL_TYPES numeric ID used to fire the test request. Lets channel
  // creation align with the shape the test passed under, so we never serve a
  // shape we did not validate.
  channelType: number;
}
