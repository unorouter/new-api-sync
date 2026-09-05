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
