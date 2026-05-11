export interface RetryPolicy<T> {
  /** Total attempts including the first call. */
  attempts: number;
  /** Wait before each retry. `backoffMs[i]` is the wait before attempt `i+2`. */
  backoffMs?: number[];
  /** Return true to keep retrying. Default: always retry on failure. */
  shouldRetry?: (result: T) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  isPass: (v: T) => boolean,
  policy: RetryPolicy<T>,
): Promise<T> {
  const shouldRetry = policy.shouldRetry ?? (() => true);
  let last = await fn();
  for (let i = 1; i < policy.attempts; i++) {
    if (isPass(last) || !shouldRetry(last)) return last;
    const delay = policy.backoffMs?.[i - 1];
    if (delay) await sleep(delay);
    last = await fn();
  }
  return last;
}

/** NVIDIA NIM: transient failures (timeouts, 429, 5xx) are worth retrying; deterministic 4xx fails fast. */
export const NVIDIA_TRANSIENT: RetryPolicy<{ status?: number | null }> = {
  attempts: 3,
  backoffMs: [2000, 4000],
  shouldRetry: (r) => {
    const s = r.status;
    if (s === undefined || s === null) return true;
    return s === 429 || s >= 500;
  },
};

/** Pagination over flaky upstreams: a single missed page truncates results. */
export const UPSTREAM_PAGE: RetryPolicy<{ status?: number | null }> = {
  attempts: 4,
  backoffMs: [0, 3000, 10_000],
  shouldRetry: (r) => {
    const s = r.status;
    if (s === undefined || s === null) return true;
    return s === 429 || s >= 500;
  },
};

/** new-api token endpoints (e.g. pol) 429 frequently; back off and retry only on rate-limit. */
export const NEWAPI_429: RetryPolicy<{
  errorClass?: string;
  status?: number | null;
}> = {
  attempts: 4,
  backoffMs: [5000, 10_000, 20_000],
  shouldRetry: (r) => r.errorClass === "ratelimit" || r.status === 429,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wrapper for raw error-message-based 429 detection (used where the result is a thrown Error, not a result object). */
export async function retryOn429<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 2000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = /\b429\b|rate ?limit|too many requests/i.test(msg);
      if (!is429 || attempt === max) throw err;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}
