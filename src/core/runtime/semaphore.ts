import pLimit, { type LimitFunction } from "p-limit";

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
      globalLimit: 20,
      perUpstreamLimit: 5,
    });
  }
  return sharedGate;
}
