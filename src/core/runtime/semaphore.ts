/**
 * Counting semaphore. Limits the number of concurrent holders to `permits`.
 * `acquire()` resolves when a permit is available; the caller must then call
 * `release()` exactly once (typically in a `finally`).
 */
export class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error("Semaphore permits must be >= 1");
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Composite gate: every call passes through the global semaphore AND the
 * per-upstream semaphore. Use this in test/probe code so a single noisy
 * upstream cannot starve other providers, while the total in-flight count
 * stays bounded.
 */
export class ConcurrencyGate {
  private global: Semaphore;
  private perUpstream = new Map<string, Semaphore>();
  private perUpstreamLimit: number;
  private overrides: Map<string, number>;

  constructor(opts: {
    globalLimit: number;
    perUpstreamLimit: number;
    overrides?: Map<string, number>;
  }) {
    this.global = new Semaphore(opts.globalLimit);
    this.perUpstreamLimit = opts.perUpstreamLimit;
    this.overrides = opts.overrides ?? new Map();
  }

  private semFor(upstreamKey: string): Semaphore {
    let sem = this.perUpstream.get(upstreamKey);
    if (!sem) {
      const limit = this.overrides.get(upstreamKey) ?? this.perUpstreamLimit;
      sem = new Semaphore(limit);
      this.perUpstream.set(upstreamKey, sem);
    }
    return sem;
  }

  async run<T>(upstreamKey: string, fn: () => Promise<T>): Promise<T> {
    const sem = this.semFor(upstreamKey);
    await sem.acquire();
    await this.global.acquire();
    try {
      return await fn();
    } finally {
      this.global.release();
      sem.release();
    }
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
