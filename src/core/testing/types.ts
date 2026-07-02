import type { EntityChangeSet } from "@core/types";

export interface TestExchange {
  pass: boolean;
  request: { url: string; headers: Record<string, string>; body: unknown };
  response: unknown;
  responseHeaders: Record<string, string>;
  error?: string;
  status?: number;
  latencyMs?: number;
  /** Tool probe only: >=2 valid calls in one turn. */
  toolParallel?: boolean;
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
  testCost?: number;
  success?: boolean;
  error?: string;
  channels?: EntityChangeSet;
  groups?: number;
  models?: number;
  tokens?: { created: number; existing: number; deleted: number };
}

interface RunSummary {
  providers: { passed: number; total: number };
  channels: EntityChangeSet;
  models: EntityChangeSet & { orphansDeleted: number };
  options: { updated: string[] };
  elapsedSeconds: number;
  success: boolean;
  errors?: Array<{ phase: string; key: string; message: string }>;
}

export interface PricingGateLog {
  exposed: string;
  vote: {
    candidates: Array<{
      source: string;
      matchedKey?: string;
      modelRatio?: number;
      completionRatio?: number;
      inputUsdPerM?: number;
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
  picked?: { provider: string; promptUsd: number; completionUsd: number };
}

export interface TestReport {
  timestamp: string;
  providers: Record<string, ProviderCostEntry>;
  summary?: RunSummary;
  modelTests: ModelTestLog[];
  pricingGate?: PricingGateLog[];
  openrouterEndpoints?: OpenRouterEndpointsLog[];
}

interface RequestBase {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
export interface RequestConfig extends RequestBase {
  isSuccess: (data: unknown) => boolean;
}
export interface StreamRequestConfig extends RequestBase {
  completionMarker: string;
}
export interface ToolProbeVerdict {
  pass: boolean;
  parallel: boolean;
}
export interface ToolCallRequestConfig extends RequestBase {
  /** OpenAI-compat SSE: tool_call deltas are reassembled before grading. */
  stream?: boolean;
  gradeToolCall: (data: unknown) => ToolProbeVerdict;
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

export interface AnthropicResponse {
  type?: string;
  content?: Array<{
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
  }>;
  stop_reason?: string;
}
export interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        functionCall?: { name?: string; args?: unknown };
        text?: string;
      }>;
    };
  }>;
}
export interface OpenAIChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      content?: string;
    };
  }>;
}
export interface OpenAIDataResponse {
  error?: unknown;
  data?: unknown[];
}
export interface ErrorEnvelope {
  error?: unknown;
}

export interface ModelTestDetail {
  model: string;
  success: boolean;
  streamSuccess: boolean | null;
  toolCallSuccess: boolean | null;
  toolParallel: boolean | null;
  authenticityProbed: boolean;
  httpStatus?: number;
  channelType: number;
}
