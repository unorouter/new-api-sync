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
