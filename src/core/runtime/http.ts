import { t } from "@server/i18n";
import { FetchError, ofetch } from "ofetch";

interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Total retry attempts on transient failures (timeouts, 408/429/5xx). ofetch's
   *  default is 1 for GET, 0 for payload methods. Pass higher when paginating
   *  flaky upstreams where a single missed page truncates results. */
  retry?: number;
  /** Milliseconds to wait between retries. Linear backoff (multiplied by attempt
   *  index) is applied automatically when this is set. */
  retryDelayMs?: number;
}

export async function fetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T> {
  try {
    return await ofetch<T>(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body as Record<string, unknown> | undefined,
      timeout: options?.timeoutMs ?? 10_000,
      retry: options?.retry,
      retryDelay: options?.retryDelayMs,
    });
  } catch (err) {
    if (err instanceof FetchError && err.response) {
      throw new Error(
        t("ERROR.HTTP_ERROR", {
          status: err.response.status,
          statusText: err.response.statusText,
        }),
      );
    }
    throw err;
  }
}

/** Like fetchJson but returns null on any HTTP or network error. */
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
