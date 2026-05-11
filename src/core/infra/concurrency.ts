import pLimit, { type LimitFunction } from "p-limit";
import { CONFIG_DEFAULTS } from "@core/config";

/** Composite gate: every call passes global AND per-upstream limiters. */
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

  private limitFor(key: string): LimitFunction {
    let limit = this.perUpstream.get(key);
    if (!limit) {
      const cap = this.overrides.get(key) ?? this.perUpstreamLimit;
      limit = pLimit(cap);
      this.perUpstream.set(key, limit);
    }
    return limit;
  }

  // global acquired inside per-upstream so a slow upstream can't hog global permits.
  run<T>(upstreamKey: string, fn: () => Promise<T>): Promise<T> {
    return this.limitFor(upstreamKey)(() => this.global(fn));
  }
}

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
