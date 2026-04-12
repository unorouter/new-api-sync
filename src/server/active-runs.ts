/**
 * Per-process registry of in-flight pipeline runs so an explicit `/api/cancel`
 * request can abort one by id without tearing down its SSE stream. That lets
 * the server finish its cleanup phase (writing reports, printing summaries)
 * and flush those final log events to the still-connected client.
 *
 * Keyed by run id; each entry holds the AbortController whose signal is fed
 * into the run via AsyncLocalStorage (see `@core/abort`).
 */
const activeRuns = new Map<string, AbortController>();

export function registerActiveRun(id: string, controller: AbortController): void {
  activeRuns.set(id, controller);
}

export function unregisterActiveRun(id: string): void {
  activeRuns.delete(id);
}

export function cancelActiveRun(id: string): boolean {
  const controller = activeRuns.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
