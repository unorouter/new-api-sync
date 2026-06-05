import { AsyncLocalStorage } from "node:async_hooks";

export interface RunContext {
  signal?: AbortSignal;
  upstreamErrors: unknown[];
}

// Per-run context, ALS-isolated so concurrent SSE clients don't share signal or error buffer.
const runStorage = new AsyncLocalStorage<RunContext>();

export function runInContext<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return runStorage.run({ signal, upstreamErrors: [] }, task);
}

export function getRunContext(): RunContext | undefined {
  return runStorage.getStore();
}

export function runWithSignal<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return signal ? runInContext(signal, task) : task();
}

export function throwIfRunAborted(): void {
  runStorage.getStore()?.signal?.throwIfAborted();
}
