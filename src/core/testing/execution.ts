import { t } from "@server/i18n";
import type {
  RawResult,
  RequestConfig,
  StreamRequestConfig,
  TestExchange,
  ToolCallRequestConfig,
} from "./types";

export interface RetryPolicy<T> {
  /** Total attempts including the first call. Default: 2. */
  attempts?: number;
  /**
   * Milliseconds to wait before each retry. Indexed by retry number, not
   * attempt number (so backoffMs[0] is the wait before the *second* attempt).
   * Default: no delay.
   */
  backoffMs?: number[];
  /**
   * Decide whether a failed result is worth retrying. Lets callers skip
   * retries on deterministic failures (404, 422) while still retrying
   * transient ones (timeout, 429, 5xx). Default: always retry on failure.
   */
  shouldRetry?: (result: T) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  isPass: (v: T) => boolean,
  policy?: RetryPolicy<T>,
): Promise<T> {
  const attempts = policy?.attempts ?? 2;
  const backoffMs = policy?.backoffMs ?? [];
  const shouldRetry = policy?.shouldRetry ?? (() => true);

  let last: T = await fn();
  for (let i = 1; i < attempts; i++) {
    if (isPass(last)) return last;
    if (!shouldRetry(last)) return last;
    const delay = backoffMs[i - 1];
    if (delay && delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    last = await fn();
  }
  return last;
}

/**
 * Retry policy tuned for NVIDIA NIM: 3 attempts with exponential-ish backoff,
 * but only for transient failures (timeouts, rate limits, server errors).
 * Deterministic 4xx responses (bad model, bad auth, validation) fail fast.
 */
export const NVIDIA_RETRY_POLICY: RetryPolicy<TestExchange> = {
  attempts: 3,
  backoffMs: [2000, 4000],
  shouldRetry: (r) => {
    // Network/abort — status undefined → worth retrying
    if (r.status === undefined || r.status === null) return true;
    // Rate limited — worth waiting and retrying
    if (r.status === 429) return true;
    // Server-side error — may self-heal
    if (r.status >= 500) return true;
    // Deterministic 4xx (400 bad body, 401 auth, 404 no model, 422 validation)
    // Retrying won't help; fail fast so the sync keeps moving.
    return false;
  },
};

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export async function rawPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<RawResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const responseHeaders = headersToRecord(response.headers);
    const bodyText = await response.text();
    let data: unknown = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // non-JSON body, keep bodyText for diagnostics
    }
    return {
      status: response.status,
      data,
      bodyText,
      error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`,
      latencyMs,
      responseHeaders,
    };
  } catch (err) {
    return {
      status: null,
      data: null,
      bodyText: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
      responseHeaders: {},
    };
  }
}

export function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as {
    error?: { message?: string; type?: string } | string;
    message?: string;
    type?: string;
  };
  if (typeof d.error === "string") return d.error;
  if (d.error?.message) return d.error.message;
  if (d.error?.type) return d.error.type;
  if (d.message) return d.message;
  if (d.type === "error") return "error response";
  return null;
}

export async function testRequest(
  config: RequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const raw = await rawPost(config.url, config.headers, config.body, timeoutMs);
  const request = { url: config.url, headers: config.headers, body: config.body };
  if (raw.data === null) {
    return {
      pass: false,
      request,
      response: raw.bodyText ?? null,
      responseHeaders: raw.responseHeaders,
      error: raw.error ?? t("CORE.TESTER.ERR_NO_RESPONSE"),
      status: raw.status ?? undefined,
      latencyMs: raw.latencyMs,
    };
  }
  const pass = raw.status !== null && raw.status < 400 && config.isSuccess(raw.data);
  return {
    pass,
    request,
    response: raw.data,
    responseHeaders: raw.responseHeaders,
    error: pass
      ? undefined
      : raw.error ??
        extractErrorMessage(raw.data) ??
        t("CORE.TESTER.ERR_BAD_RESPONSE"),
    status: raw.status ?? undefined,
    latencyMs: raw.latencyMs,
  };
}

export async function testStreamRequest(
  config: StreamRequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const reqInfo = { url: config.url, headers: config.headers, body: config.body };
  const started = Date.now();
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(config.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) {
      const errBody = await response.text().catch(() => "");
      return {
        pass: false,
        request: reqInfo,
        response: errBody || null,
        responseHeaders: headersToRecord(response.headers),
        error: t("CORE.TESTER.ERR_HTTP_STATUS", { status: response.status }),
        status: response.status,
        latencyMs: Date.now() - started,
      };
    }

    const respHeaders = headersToRecord(response.headers);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let foundMarker = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (buffer.includes(config.completionMarker)) {
        foundMarker = true;
        reader.cancel();
        break;
      }

      if (buffer.startsWith("{") && buffer.includes('"error"')) {
        reader.cancel();
        return {
          pass: false,
          request: reqInfo,
          response: buffer.slice(0, 500),
          responseHeaders: respHeaders,
          error: t("CORE.TESTER.ERR_STREAM"),
          status: response.status,
          latencyMs: Date.now() - started,
        };
      }
    }

    return {
      pass: foundMarker,
      request: reqInfo,
      response: buffer.slice(0, 500),
      responseHeaders: respHeaders,
      error: foundMarker ? undefined : t("CORE.TESTER.ERR_STREAM_NO_MARKER"),
      status: response.status,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      pass: false,
      request: reqInfo,
      response: null,
      responseHeaders: {},
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

export async function testToolCall(
  config: ToolCallRequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const raw = await rawPost(config.url, config.headers, config.body, timeoutMs);
  const request = { url: config.url, headers: config.headers, body: config.body };
  if (raw.data === null) {
    return {
      pass: false,
      request,
      response: raw.bodyText ?? null,
      responseHeaders: raw.responseHeaders,
      error: raw.error ?? t("CORE.TESTER.ERR_NO_RESPONSE"),
      status: raw.status ?? undefined,
      latencyMs: raw.latencyMs,
    };
  }
  const pass =
    raw.status !== null && raw.status < 400 && config.isToolCallSuccess(raw.data);
  return {
    pass,
    request,
    response: raw.data,
    responseHeaders: raw.responseHeaders,
    error: pass
      ? undefined
      : raw.error ??
        extractErrorMessage(raw.data) ??
        t("CORE.TESTER.ERR_TOOL_CALL_MISSING"),
    status: raw.status ?? undefined,
    latencyMs: raw.latencyMs,
  };
}
