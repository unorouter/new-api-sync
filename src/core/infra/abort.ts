import { AsyncLocalStorage } from "node:async_hooks";

/** Per-pipeline abort context. ALS so concurrent SSE clients keep their own signals. */
const abortStorage = new AsyncLocalStorage<AbortSignal>();

export function runWithSignal<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return signal ? abortStorage.run(signal, task) : task();
}

export function throwIfRunAborted(): void {
  abortStorage.getStore()?.throwIfAborted();
}
