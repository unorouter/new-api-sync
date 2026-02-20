export async function fetchJson<T>(
  url: string,
  options?: {
    headers?: Record<string, string>;
    method?: string;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const response = await fetch(url, {
    method: options?.method,
    headers: options?.headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
