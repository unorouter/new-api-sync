import { consola } from "consola";

// Sequential phases via mark() (delta since the previous mark) and concurrent
// work via track() (own start/stop); both land in one insertion-ordered report.
const phases: [string, number][] = [];
let anchor = 0;

export function timingReset(): void {
  phases.length = 0;
  anchor = Date.now();
}

export function timingMark(label: string): void {
  const now = Date.now();
  phases.push([label, now - anchor]);
  anchor = now;
}

export function timingTrack<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  return fn().finally(() => phases.push([label, Date.now() - start]));
}

export function timingReport(): void {
  if (phases.length === 0) return;
  const rows = phases
    .filter(([, ms]) => ms >= 100)
    .map(([l, ms]) => `${l} ${(ms / 1000).toFixed(1)}s`);
  consola.info(`[timing] ${rows.join(" | ")}`);
}
