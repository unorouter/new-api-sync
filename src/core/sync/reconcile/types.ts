export interface UpstreamLogRow {
  id: number;
  created_at: number;
  type: number;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  token_name: string;
  token_id?: number;
  request_id?: string;
  channel?: number;
  use_time?: number;
  ip?: string;
  user_agent?: string;
  // Raw upstream json, present only on freshly fetched rows.
  other?: string;
}

export interface GatewayLogRow {
  id: number;
  type: number;
  created_at: number;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  channel_id: number;
  token_name: string;
  request_id: string;
  upstream_request_id: string | null;
}

export type LeakKind = "abandoned" | "probe" | "unexplained";

export interface LeakGroup {
  kind: LeakKind;
  tokenName: string;
  model: string;
  rows: number;
  quota: number;
  first: number;
  last: number;
  foreignToken: boolean;
  sampleRequestIds: string[];
}

export interface ForeignToken {
  name: string;
  id: number | null;
  exists: boolean;
  rows: number;
  quota: number;
}

export type SourceStatus =
  | { status: "ok" }
  | { status: "unavailable"; httpStatus?: number; error: string };

export interface MatchCounts {
  byId: number;
  byIdViaErrorRow: number;
  byFallback: number;
  byFallbackZeroTokens: number;
  byFallbackLoose: number;
  quota: number;
}

export interface SourceIp {
  ip: string;
  rows: number;
  quota: number;
  ours: boolean | null;
}

export interface ProviderReconcile {
  name: string;
  type: "newapi" | "a7";
  channelIds: number[];
  upstreamLogs: SourceStatus;
  tokenList: SourceStatus;
  upstreamIncomplete: boolean;
  upstream: { rows: number; quota: number };
  matched: MatchCounts;
  leaks: LeakGroup[];
  leakSummary: Record<LeakKind, { rows: number; quota: number }>;
  ourUnmatched: {
    rows: number;
    quota: number;
    sample: {
      id: number;
      upstreamRequestId: string | null;
      model: string;
      createdAt: number;
    }[];
  };
  ours: { rows: number; quota: number };
  quotaDelta: number;
  foreignTokens: ForeignToken[];
  sourceIps: SourceIp[];
  error?: string;
}

export interface OpenRouterForeignKey {
  name: string;
  hash?: string;
  disabled?: boolean;
  limit?: number | null;
  usage?: number;
  usageDaily?: number;
  createdAt?: string;
}

export interface OpenRouterReconcile {
  name: string;
  status: "ok" | "no-management-key" | "error";
  foreignKeys: OpenRouterForeignKey[];
  error?: string;
}

export interface ReconcileResult {
  window: { start: number; end: number; since: string };
  dbMode: "postgres" | "provider-only";
  providers: ProviderReconcile[];
  openrouter: OpenRouterReconcile[];
  unavailable: string[];
  verdict: "clean" | "leak";
  artifactPath?: string;
}

// Evidence rows kept out of the summary but written to the artifact.
export interface ProviderEvidence {
  name: string;
  leakRows: UpstreamLogRow[];
  matchedViaError: { upstream: UpstreamLogRow; ours: GatewayLogRow[] }[];
}
