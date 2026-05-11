import { FetchError, ofetch } from "ofetch";
import { t } from "@server/i18n";

interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  retry?: number;
  retryDelayMs?: number;
}

export async function fetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T> {
  try {
    // responseType: "json" forces parse — GitHub raw serves JSON as text/plain.
    return await ofetch<T>(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body as Record<string, unknown> | undefined,
      timeout: options?.timeoutMs ?? 10_000,
      retry: options?.retry,
      retryDelay: options?.retryDelayMs,
      responseType: "json",
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
