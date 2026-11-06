import { clickhouseLines } from "@core/sync/reconcile/gateway-logs";

/** One lane's real traffic in a window, read from the gateway's request log. */
export interface LaneStat {
  channelId: number;
  model: string;
  requests: number;
  users: number;
  /** Error rows by class; 429 is capacity, which the gateway already cools. */
  errors429: number;
  errors5xx: number;
  errorsRefused: number;
  errorsOther: number;
  /** Consume rows that billed no output at all. */
  emptyOk: number;
  /** Consume rows with at most SHORT_MAX_OUT tokens out for a long prompt. */
  shortOk: number;
  good: number;
  p50Seconds: number | null;
  /** Mean billed input per consume row. */
  avgPrompt: number;
  /** Median output tokens per second over rows with a real answer. */
  p50TokensPerSecond: number | null;
  /** Mean billed input over cached input, on rows with a sizable cache hit. */
  promptPerCached: number | null;
}

export const SHORT_MAX_OUT = 30;
export const SHORT_MIN_PROMPT = 2000;

// Error rows carry the upstream status in their content ("status_code=502, ...");
// a merchant refusal is a 400 whose text names it (a7: 该商家拒绝了本次请求).
const QUERY = `
SELECT
  channel_id AS channelId,
  any(model_name) AS model,
  toUInt32(count()) AS requests,
  toUInt32(uniq(user_id)) AS users,
  toUInt32(countIf(type = 5 AND content LIKE '%status_code=429%')) AS errors429,
  toUInt32(countIf(type = 5 AND content LIKE '%status_code=5%')) AS errors5xx,
  toUInt32(countIf(type = 5 AND content LIKE '%status_code=400%' AND (content LIKE '%拒绝%' OR content LIKE '%refus%' OR content LIKE '%reject%'))) AS errorsRefused,
  toUInt32(countIf(type = 2 AND completion_tokens = 0)) AS emptyOk,
  toUInt32(countIf(type = 2 AND completion_tokens > 0 AND completion_tokens <= {shortMax:UInt32} AND prompt_tokens > {shortPrompt:UInt32})) AS shortOk,
  toUInt32(countIf(type = 2 AND completion_tokens > {shortMax:UInt32})) AS good,
  toUInt32(countIf(type = 5)) AS errorsAll,
  quantileIf(0.5)(use_time, type = 2) AS p50,
  avgIf(prompt_tokens, type = 2) AS avgPrompt,
  quantileIf(0.5)(completion_tokens / greatest(use_time, 1), type = 2 AND completion_tokens > 200) AS p50Tps,
  avgIf(prompt_tokens / JSONExtractInt(other, 'cache_tokens'), type = 2 AND JSONExtractInt(other, 'cache_tokens') > 1000) AS promptPerCached
FROM logs
WHERE type IN (2, 5) AND channel_id > 0
  AND created_at >= {from:Int64} AND created_at < {to:Int64}
GROUP BY channel_id`;

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return 0;
}

/** Every lane with traffic in [from, to), unix seconds. */
export async function fetchLaneStats(
  url: string,
  from: number,
  to: number,
): Promise<LaneStat[]> {
  const lines = await clickhouseLines(url, QUERY, {
    from: String(Math.floor(from)),
    to: String(Math.floor(to)),
    shortMax: String(SHORT_MAX_OUT),
    shortPrompt: String(SHORT_MIN_PROMPT),
  });
  return lines.map((line) => {
    const raw: unknown = JSON.parse(line);
    const r: Record<string, unknown> =
      typeof raw === "object" && raw !== null ? { ...raw } : {};
    const errorsAll = num(r.errorsAll);
    const errors429 = num(r.errors429);
    const errors5xx = num(r.errors5xx);
    const errorsRefused = num(r.errorsRefused);
    const p50 = r.p50 === null || r.p50 === undefined ? null : num(r.p50);
    const finite = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = num(v);
      return n > 0 ? n : null;
    };
    return {
      channelId: num(r.channelId),
      model: typeof r.model === "string" ? r.model : "",
      requests: num(r.requests),
      users: num(r.users),
      errors429,
      errors5xx,
      errorsRefused,
      errorsOther: Math.max(
        0,
        errorsAll - errors429 - errors5xx - errorsRefused,
      ),
      emptyOk: num(r.emptyOk),
      shortOk: num(r.shortOk),
      good: num(r.good),
      p50Seconds: p50 !== null && Number.isFinite(p50) ? p50 : null,
      avgPrompt: num(r.avgPrompt),
      p50TokensPerSecond: finite(r.p50Tps),
      promptPerCached: finite(r.promptPerCached),
    };
  });
}

/** Errors the grader counts: everything but 429 capacity answers. */
export const countedErrors = (s: LaneStat): number =>
  s.errors5xx + s.errorsRefused + s.errorsOther;
