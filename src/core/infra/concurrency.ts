import pLimit, { type LimitFunction } from "p-limit";
import { CONFIG_DEFAULTS } from "@core/config";

/** Composite gate: every call passes global AND per-upstream limiters. */
export class ConcurrencyGate {
  private global: LimitFunction;
  private perUpstream = new Map<string, LimitFunction>();
  private perUpstreamLimit: number;
  private overrides: Map<string, number>;
  // Hosts with a per-minute request cap: every outbound probe request to that
  // host is spaced so no more than `rpm` start in a minute, whichever code path
  // issues it (model test, authenticity, verifier).
  private rpmByHost: Map<string, number>;
  private nextStartAt = new Map<string, number>();

  constructor(opts: {
    globalLimit: number;
    perUpstreamLimit: number;
    overrides?: Map<string, number>;
    rpmOverrides?: Map<string, number>;
  }) {
    this.global = pLimit(opts.globalLimit);
    this.perUpstreamLimit = opts.perUpstreamLimit;
    this.overrides = opts.overrides ?? new Map();
    this.rpmByHost = new Map();
    for (const [key, rpm] of opts.rpmOverrides ?? new Map<string, number>())
      this.rpmByHost.set(hostOf(key), rpm);
  }

  async paceRequest(url: string): Promise<void> {
    const host = hostOf(url);
    const rpm = this.rpmByHost.get(host);
    if (!rpm) return;
    const interval = 60_000 / rpm;
    const now = Date.now();
    const at = Math.max(now, this.nextStartAt.get(host) ?? 0);
    this.nextStartAt.set(host, at + interval);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
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

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

let sharedGate: ConcurrencyGate | null = null;

export const paceUpstreamRequest = (url: string): Promise<void> =>
  getConcurrencyGate().paceRequest(url);

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
