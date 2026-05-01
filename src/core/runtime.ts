import { AsyncLocalStorage } from "node:async_hooks";
import pLimit, { type LimitFunction } from "p-limit";
import { CONFIG_DEFAULTS } from "@core/config";
import { t } from "@server/i18n";
import { FetchError, ofetch } from "ofetch";

// ============ Abort signal (per-pipeline) ============

/**
 * Per-pipeline abort context backed by AsyncLocalStorage.
 *
 * Threading an `AbortSignal` parameter through every provider call would
 * touch a lot of signatures for a concept that's naturally scoped to the
 * active run. ALS carries the signal along the async call tree instead, so
 * loop hot-spots can just call `throwIfRunAborted()` and bail out when the
 * user clicks Stop. Unlike a module-level variable, this is safe under
 * concurrent pipelines (each `runWithSignal` block has its own context).
 */
const abortStorage = new AsyncLocalStorage<AbortSignal>();

/**
 * Wrap an async task so code inside its call tree can observe `signal` via
 * `throwIfRunAborted()`. If `signal` is undefined the helper becomes a no-op.
 */
export function runWithSignal<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!signal) return task();
  return abortStorage.run(signal, task);
}

export function throwIfRunAborted(): void {
  abortStorage.getStore()?.throwIfAborted();
}

// ============ HTTP (ofetch wrapper) ============

interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Total retry attempts on transient failures (timeouts, 408/429/5xx). ofetch's
   *  default is 1 for GET, 0 for payload methods. Pass higher when paginating
   *  flaky upstreams where a single missed page truncates results. */
  retry?: number;
  /** Milliseconds to wait between retries. Linear backoff (multiplied by attempt
   *  index) is applied automatically when this is set. */
  retryDelayMs?: number;
}

export async function fetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T> {
  try {
    // Force JSON parsing regardless of upstream Content-Type. GitHub raw
    // serves JSON files as text/plain, which makes ofetch hand back a
    // string instead of the parsed object — silently breaking
    // Object.entries / property access on the response.
    return await ofetch<T>(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body as Record<string, unknown> | undefined,
      timeout: options?.timeoutMs ?? 10_000,
      retry: options?.retry,
      retryDelay: options?.retryDelayMs,
      responseType: "json",
    });
  } catch (err) {
    if (err instanceof FetchError && err.response) {
      throw new Error(
        t("ERROR.HTTP_ERROR", {
          status: err.response.status,
          statusText: err.response.statusText,
        }),
      );
    }
    throw err;
  }
}

/** Like fetchJson but returns null on any HTTP or network error. */
export async function tryFetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T | null> {
  try {
    return await fetchJson<T>(url, options);
  } catch {
    return null;
  }
}

// ============ Concurrency gate ============

/**
 * Composite gate: every call passes through the global limiter AND the
 * per-upstream limiter. Use this in test/probe code so a single noisy
 * upstream cannot starve other providers, while the total in-flight count
 * stays bounded.
 */
export class ConcurrencyGate {
  private global: LimitFunction;
  private perUpstream = new Map<string, LimitFunction>();
  private perUpstreamLimit: number;
  private overrides: Map<string, number>;

  constructor(opts: {
    globalLimit: number;
    perUpstreamLimit: number;
    overrides?: Map<string, number>;
  }) {
    this.global = pLimit(opts.globalLimit);
    this.perUpstreamLimit = opts.perUpstreamLimit;
    this.overrides = opts.overrides ?? new Map();
  }

  private limitFor(upstreamKey: string): LimitFunction {
    let limit = this.perUpstream.get(upstreamKey);
    if (!limit) {
      const cap = this.overrides.get(upstreamKey) ?? this.perUpstreamLimit;
      limit = pLimit(cap);
      this.perUpstream.set(upstreamKey, limit);
    }
    return limit;
  }

  /**
   * Run `fn` under both the per-upstream and global limiter. The global
   * limiter is acquired inside the per-upstream limiter so a slow upstream
   * cannot hog global permits while waiting on its own per-upstream cap.
   */
  run<T>(upstreamKey: string, fn: () => Promise<T>): Promise<T> {
    const perUpstream = this.limitFor(upstreamKey);
    return perUpstream(() => this.global(fn));
  }
}

/**
 * Module-level shared gate. The pipeline initialises this once with values
 * from RuntimeConfig; testModels / probeChannelType read it through
 * `getConcurrencyGate()`. Tests and standalone runs that don't initialise
 * fall back to a permissive default.
 */
let sharedGate: ConcurrencyGate | null = null;

export function setConcurrencyGate(gate: ConcurrencyGate): void {
  sharedGate = gate;
}

export function getConcurrencyGate(): ConcurrencyGate {
  if (!sharedGate) {
    sharedGate = new ConcurrencyGate({
      globalLimit: CONFIG_DEFAULTS.globalConcurrency,
      perUpstreamLimit: CONFIG_DEFAULTS.perUpstreamConcurrency,
    });
  }
  return sharedGate;
}
