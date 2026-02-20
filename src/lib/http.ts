interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

function buildRequest(
  url: string,
  options?: FetchOptions
): [string, RequestInit] {
  return [
    url,
    {
      method: options?.method,
      headers: options?.headers,
      body:
        options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000)
    }
  ];
}

export async function fetchJson<T>(
  url: string,
  options?: FetchOptions
): Promise<T> {
  const response = await fetch(...buildRequest(url, options));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/** Like fetchJson but returns null on any HTTP or network error. */
export async function tryFetchJson<T>(
  url: string,
  options?: FetchOptions
): Promise<T | null> {
  try {
    return await fetchJson<T>(url, options);
  } catch {
    return null;
  }
}
