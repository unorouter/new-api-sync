import { FetchError, ofetch } from "ofetch";
import { t } from "@server/i18n";
import { withRetry } from "./retry";

// A bare "HTTP 403" names neither the host nor the route, so a failing run gives
// no way to tell our own gateway from an upstream. Query strings can carry keys,
// so only origin + path is reported.
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  retry?: number;
  retryDelayMs?: number;
}

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | undefined; message: string };

// Same statuses ofetch retries on; a missing status is a network error or timeout.
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// Keeps the HTTP status so a caller can tell "route does not exist" (404)
// from "refused" or "unreachable"; the other two helpers flatten it.
export async function fetchJsonResult<T>(
  url: string,
  options?: FetchOptions,
): Promise<FetchResult<T>> {
  const attempts = (options?.retry ?? 0) + 1;
  const delay = options?.retryDelayMs ?? 0;
  return withRetry(() => fetchOnce<T>(url, options), (r) => r.ok, {
    attempts,
    backoffMs: Array.from({ length: attempts - 1 }, () => delay),
    shouldRetry: (r) =>
      !r.ok && (r.status === undefined || RETRY_STATUS.has(r.status)),
  });
}

async function fetchOnce<T>(
  url: string,
  options?: FetchOptions,
): Promise<FetchResult<T>> {
  try {
    // responseType: "json" forces parse; GitHub raw serves JSON as text/plain.
    // ofetch derives one signal from `timeout` and reuses it across its own
    // retries, so after a timeout every retry aborts instantly: fresh signal
    // per attempt, retries done here.
    const data = await ofetch<T>(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body as Record<string, unknown> | undefined,
      signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
      retry: false,
      responseType: "json",
    });
    return { ok: true, data };
  } catch (err) {
    if (err instanceof FetchError && err.response)
      return {
        ok: false,
        status: err.response.status,
        message: t("ERROR.HTTP_ERROR", {
          status: err.response.status,
          statusText: err.response.statusText,
          url: redactUrl(url),
        }),
      };
    return {
      ok: false,
      status: undefined,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T> {
  const r = await fetchJsonResult<T>(url, options);
  if (r.ok) return r.data;
  throw new Error(r.message);
}

export async function tryFetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T | null> {
  try {
    return await fetchJson<T>(url, options);
  } catch {
    return null;
  }
}
