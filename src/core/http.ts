import { ofetch, type FetchOptions } from "ofetch";
import pRetry, { AbortError } from "p-retry";

export interface HttpRequestOptions extends FetchOptions {
  timeoutMs?: number;
  retries?: number;
}

function isRetriable(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("5")
  );
}

export async function requestJson<T>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<T> {
  const { timeoutMs = 10_000, retries = 3, ...fetchOptions } = options;

  return pRetry(
    async () => {
      try {
        return await ofetch<T>(url, {
          ...(fetchOptions as FetchOptions<"json">),
          responseType: "json",
          timeout: timeoutMs,
        });
      } catch (error) {
        if (!isRetriable(error)) {
          throw new AbortError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    },
    {
      retries: Math.max(0, retries - 1),
      factor: 2,
      minTimeout: 500,
      maxTimeout: 10_000,
      randomize: false,
    },
  );
}
