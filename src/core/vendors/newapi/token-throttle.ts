import { throwIfRunAborted } from "@core/infra/abort";
import { consola } from "consola";

// The relay rate limits its token routes per account, not per call, so once a
// reveal or a create answers 429 every later call pays the same retry ladder
// and still comes back empty: on the 2026-09-15 14:00 walk that was 11 lanes at
// about 96 s each. One cooldown per base URL turns the whole throttled stretch
// into a single wait.
//
// The wait is served, not skipped. Skipping handed the lanes to "a later round or
// the next run", but every run meets the same limit: the 2026-09-18 10:00 walk
// dropped 94 token creates and 112 lanes behind one 429 and exited 1, as had
// most walks that week. A budget bounds the total so a relay that never stops
// refusing degrades to the old skip instead of eating the job deadline.
const DEFAULT_COOLDOWN_MS = 60_000;

const MAX_COOLDOWN_MS = 5 * 60_000;
const WAIT_BUDGET_MS = 30 * 60_000;

const cooldownUntil = new Map<string, number>();
const waitedMs = new Map<string, number>();
// Refusals in a row, cleared by the first call that gets through. a7's reveal
// limit outlasts a flat minute: on 2026-09-18 seven waits of 60 s each met a
// fresh 429 and seven lanes went unkeyed, so the wait doubles until one lands.
const strikes = new Map<string, number>();

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
  const strike = (strikes.get(baseUrl) ?? 0) + 1;
  strikes.set(baseUrl, strike);
  const escalated = Math.min(
    DEFAULT_COOLDOWN_MS * 2 ** (strike - 1),
    MAX_COOLDOWN_MS,
  );
  cooldownUntil.set(
    baseUrl,
    Date.now() + Math.max(retryAfterMs ?? 0, escalated),
  );
}

export function clearTokenThrottle(baseUrl: string): void {
  cooldownUntil.delete(baseUrl);
  strikes.delete(baseUrl);
}

// Resolves true once the base URL is clear to call, false when the run has
// already spent its wait budget there and the caller should skip.
export async function awaitTokenThrottle(baseUrl: string): Promise<boolean> {
  for (;;) {
    const remaining = tokenThrottleRemainingMs(baseUrl);
    if (remaining <= 0) return true;
    const spent = waitedMs.get(baseUrl) ?? 0;
    if (spent + remaining > WAIT_BUDGET_MS) return false;
    throwIfRunAborted();
    consola.info(
      `[throttle] ${new URL(baseUrl).host} is rate limiting token routes, waiting ${Math.ceil(remaining / 1000)}s (${Math.round(spent / 1000)}s of ${WAIT_BUDGET_MS / 1000}s budget spent)`,
    );
    await new Promise((r) => setTimeout(r, remaining));
    waitedMs.set(baseUrl, spent + remaining);
  }
}
