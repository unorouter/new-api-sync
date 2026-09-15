// The relay rate limits its token routes per account, not per call, so once a
// reveal or a create answers 429 every later call pays the same retry ladder
// and still comes back empty: on the 2026-09-15 14:00 walk that was 11 lanes at
// about 96 s each. One cooldown per base URL turns the whole throttled stretch
// into a single wait; the lanes it skips are keyed on a later round or the next
// run, which is what the verdict cache and the lane key cache are for.
const DEFAULT_COOLDOWN_MS = 60_000;

const cooldownUntil = new Map<string, number>();

export function tokenThrottleRemainingMs(baseUrl: string): number {
  const until = cooldownUntil.get(baseUrl);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldownUntil.delete(baseUrl);
    return 0;
  }
  return remaining;
}

export function noteTokenThrottle(
  baseUrl: string,
  retryAfterMs?: number,
): void {
  cooldownUntil.set(
    baseUrl,
    Date.now() + Math.max(retryAfterMs ?? 0, DEFAULT_COOLDOWN_MS),
  );
}

export function clearTokenThrottle(baseUrl: string): void {
  cooldownUntil.delete(baseUrl);
}
