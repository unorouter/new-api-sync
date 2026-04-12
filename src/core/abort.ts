import { AsyncLocalStorage } from "node:async_hooks";

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
const storage = new AsyncLocalStorage<AbortSignal>();

/**
 * Wrap an async task so code inside its call tree can observe `signal` via
 * `throwIfRunAborted()` / `isRunAborted()`. If `signal` is undefined the
 * helpers become no-ops.
 */
export function runWithSignal<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!signal) return task();
  return storage.run(signal, task);
}

export function throwIfRunAborted(): void {
  storage.getStore()?.throwIfAborted();
}

export function isRunAborted(): boolean {
  return storage.getStore()?.aborted ?? false;
}
