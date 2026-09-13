import type {
  ForeignToken,
  GatewayLogRow,
  LeakGroup,
  LeakKind,
  MatchCounts,
  ProviderEvidence,
  UpstreamLogRow,
} from "./types";

const FALLBACK_WINDOW_SECONDS = 120;
// Relays retry upstream internally and bill the successful attempt under a
// new request id, and some count cached or thinking tokens differently, so
// a last pass accepts a same-model row nearby whose tokens are in the
// neighbourhood; it only ever claims rows nothing else claimed.
const LOOSE_TOKEN_TOLERANCE = 0.35;
// A relay bills an attempt the gateway timed out on and retried elsewhere;
// our side keeps only the error row, within this many seconds.
const ABANDONED_WINDOW_SECONDS = 180;
// Verifier and sync probes: a few hundred prompt tokens, a handful out.
const PROBE_MAX_PROMPT = 600;
const PROBE_MAX_COMPLETION = 100;
const SAMPLE_IDS = 5;
const OUR_SAMPLE = 20;

export interface MatchInput {
  upstream: UpstreamLogRow[];
  ours: GatewayLogRow[];
  // Error rows on any channel, for the abandoned-attempt classification.
  ourErrors: GatewayLogRow[];
  // Request ids of the sync's own probes, recorded when they were sent.
  probeIds: Set<string>;
  window: { start: number; end: number };
  laneNarrow?: (tokenName: string) => Set<number> | null;
  isOurToken: (name: string) => boolean;
  listedTokens: { id: number; name: string }[] | null;
}

export interface MatchOutput {
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
  foreignTokens: ForeignToken[];
  evidence: Omit<ProviderEvidence, "name">;
}

export function matchProvider(input: MatchInput): MatchOutput {
  const byUpstreamId = new Map<string, GatewayLogRow[]>();
  for (const r of input.ours) {
    if (!r.upstream_request_id) continue;
    const list = byUpstreamId.get(r.upstream_request_id) ?? [];
    list.push(r);
    byUpstreamId.set(r.upstream_request_id, list);
  }
  const claimed = new Set<number>();
  const matched: MatchCounts = {
    byId: 0,
    byIdViaErrorRow: 0,
    byFallback: 0,
    byFallbackZeroTokens: 0,
    byFallbackLoose: 0,
    quota: 0,
  };
  const matchedViaError: ProviderEvidence["matchedViaError"] = [];
  const unmatched: UpstreamLogRow[] = [];

  for (const u of input.upstream) {
    const hits = u.request_id ? byUpstreamId.get(u.request_id) : undefined;
    if (!hits || hits.length === 0) {
      unmatched.push(u);
      continue;
    }
    for (const h of hits) claimed.add(h.id);
    matched.quota += u.quota;
    if (hits.some((h) => h.type === 2)) matched.byId++;
    else {
      matched.byIdViaErrorRow++;
      matchedViaError.push({ upstream: u, ours: hits });
    }
  }

  // Candidates for the fallback: our consume rows nothing claimed, bucketed
  // by token counts so the scan per upstream row stays small.
  const byTokens = new Map<string, GatewayLogRow[]>();
  for (const r of input.ours) {
    if (r.type !== 2 || claimed.has(r.id)) continue;
    const k = `${r.prompt_tokens}|${r.completion_tokens}`;
    const list = byTokens.get(k) ?? [];
    list.push(r);
    byTokens.set(k, list);
  }
  const still: UpstreamLogRow[] = [];
  for (const u of unmatched) {
    const lane = input.laneNarrow?.(u.token_name) ?? null;
    const zero = u.prompt_tokens === 0 && u.completion_tokens === 0;
    const pool =
      byTokens.get(`${u.prompt_tokens}|${u.completion_tokens}`) ?? [];
    let best: GatewayLogRow | null = null;
    let bestDelta = Infinity;
    for (const r of pool) {
      if (claimed.has(r.id)) continue;
      if (lane && !lane.has(r.channel_id)) continue;
      if (zero && r.model_name !== u.model_name) continue;
      const delta = Math.abs(r.created_at - u.created_at);
      if (delta > FALLBACK_WINDOW_SECONDS) continue;
      const better =
        delta < bestDelta ||
        (delta === bestDelta &&
          best !== null &&
          best.model_name !== u.model_name &&
          r.model_name === u.model_name);
      if (better) {
        best = r;
        bestDelta = delta;
      }
    }
    if (!best) {
      still.push(u);
      continue;
    }
    claimed.add(best.id);
    matched.quota += u.quota;
    if (zero) matched.byFallbackZeroTokens++;
    else matched.byFallback++;
  }

  const near = (a: number, b: number) =>
    Math.abs(a - b) <= Math.max(a, b) * LOOSE_TOKEN_TOLERANCE;
  const remaining: UpstreamLogRow[] = [];
  for (const u of still) {
    const lane = input.laneNarrow?.(u.token_name) ?? null;
    let best: GatewayLogRow | null = null;
    let bestDelta = Infinity;
    for (const r of input.ours) {
      if (r.type !== 2 || claimed.has(r.id)) continue;
      if (lane && !lane.has(r.channel_id)) continue;
      if (r.model_name.toLowerCase() !== u.model_name.toLowerCase()) continue;
      const delta = Math.abs(r.created_at - u.created_at);
      if (delta > FALLBACK_WINDOW_SECONDS) continue;
      if (
        !near(r.completion_tokens, u.completion_tokens) &&
        !near(r.prompt_tokens, u.prompt_tokens)
      )
        continue;
      if (delta < bestDelta) {
        best = r;
        bestDelta = delta;
      }
    }
    if (!best) {
      remaining.push(u);
      continue;
    }
    claimed.add(best.id);
    matched.quota += u.quota;
    matched.byFallbackLoose++;
  }
  still.length = 0;
  still.push(...remaining);

  const errorsByModel = new Map<string, GatewayLogRow[]>();
  for (const r of input.ourErrors) {
    const k = r.model_name.toLowerCase();
    const list = errorsByModel.get(k) ?? [];
    list.push(r);
    errorsByModel.set(k, list);
  }
  const classify = (u: UpstreamLogRow): LeakKind => {
    if (u.request_id && input.probeIds.has(u.request_id)) return "probe";
    const ourToken = input.isOurToken(u.token_name);
    if (!ourToken) return "unexplained";
    const errs = errorsByModel.get(u.model_name.toLowerCase()) ?? [];
    if (
      errs.some(
        (r) =>
          Math.abs(r.created_at - u.created_at) <= ABANDONED_WINDOW_SECONDS,
      )
    )
      return "abandoned";
    if (
      u.prompt_tokens <= PROBE_MAX_PROMPT &&
      u.completion_tokens <= PROBE_MAX_COMPLETION
    )
      return "probe";
    return "unexplained";
  };
  const leakSummary: Record<LeakKind, { rows: number; quota: number }> = {
    abandoned: { rows: 0, quota: 0 },
    probe: { rows: 0, quota: 0 },
    unexplained: { rows: 0, quota: 0 },
  };
  const groups = new Map<string, LeakGroup>();
  for (const u of still) {
    const kind = classify(u);
    leakSummary[kind].rows++;
    leakSummary[kind].quota += u.quota;
    const k = `${kind}|${u.token_name}|${u.model_name}`;
    const g = groups.get(k) ?? {
      kind,
      tokenName: u.token_name,
      model: u.model_name,
      rows: 0,
      quota: 0,
      first: u.created_at,
      last: u.created_at,
      foreignToken: !input.isOurToken(u.token_name),
      sampleRequestIds: [],
    };
    g.rows++;
    g.quota += u.quota;
    g.first = Math.min(g.first, u.created_at);
    g.last = Math.max(g.last, u.created_at);
    if (u.request_id && g.sampleRequestIds.length < SAMPLE_IDS)
      g.sampleRequestIds.push(u.request_id);
    groups.set(k, g);
  }
  const leaks = [...groups.values()].sort((a, b) => b.quota - a.quota);

  const ourLeft = input.ours.filter(
    (r) =>
      r.type === 2 &&
      !claimed.has(r.id) &&
      r.created_at >= input.window.start &&
      r.created_at <= input.window.end,
  );
  const ourUnmatched = {
    rows: ourLeft.length,
    quota: ourLeft.reduce((n, r) => n + r.quota, 0),
    sample: ourLeft.slice(0, OUR_SAMPLE).map((r) => ({
      id: r.id,
      upstreamRequestId: r.upstream_request_id,
      model: r.model_name,
      createdAt: r.created_at,
    })),
  };

  const usageByToken = new Map<string, { rows: number; quota: number }>();
  for (const u of input.upstream) {
    const s = usageByToken.get(u.token_name) ?? { rows: 0, quota: 0 };
    s.rows++;
    s.quota += u.quota;
    usageByToken.set(u.token_name, s);
  }
  const foreign = new Map<string, ForeignToken>();
  for (const tk of input.listedTokens ?? []) {
    if (input.isOurToken(tk.name)) continue;
    const s = usageByToken.get(tk.name) ?? { rows: 0, quota: 0 };
    foreign.set(tk.name, { name: tk.name, id: tk.id, exists: true, ...s });
  }
  // A token seen in the log but absent from the list was deleted after use.
  if (input.listedTokens)
    for (const [name, s] of usageByToken) {
      if (foreign.has(name) || input.isOurToken(name)) continue;
      foreign.set(name, { name, id: null, exists: false, ...s });
    }
  const foreignTokens = [...foreign.values()].sort((a, b) => b.quota - a.quota);

  return {
    matched,
    leaks,
    leakSummary,
    ourUnmatched,
    foreignTokens,
    evidence: { leakRows: still, matchedViaError },
  };
}
