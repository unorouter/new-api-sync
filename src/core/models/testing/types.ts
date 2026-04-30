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
  testCost: number;
}

export interface TestReport {
  timestamp: string;
  /** Per-provider summary keyed by provider config name. Only providers that
   *  expose a balance API contribute entries (newapi, openrouter, sub2api).
   *  Providers without balance access (nvidia) are omitted. */
  providers: Record<string, ProviderCostEntry>;
  /** All per-model test logs across the run. Replaces the legacy `results`
   *  field (still accepted on read for back-compat with old report files). */
  modelTests: ModelTestLog[];
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
