export interface TestExchange {
  pass: boolean;
  request: { url: string; body: unknown };
  response: unknown;
  error?: string;
  status?: number;
  latencyMs?: number;
}

export interface KiroProbeLog {
  probe: string;
  pass: boolean;
  kiroRefusal: boolean;
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
  kiroProbes?: KiroProbeLog[];
}

export interface TestReport {
  timestamp: string;
  results: ModelTestLog[];
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
}

export interface ModelTestDetail {
  model: string;
  success: boolean;
  streamSuccess: boolean | null;
  toolCallSuccess: boolean | null;
  kiroProbed: boolean;
}
