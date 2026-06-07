import { t } from "@server/i18n";
import type {
  RawResult,
  RequestConfig,
  StreamRequestConfig,
  TestExchange,
  ToolCallRequestConfig,
} from "./types";

export interface RetryPolicy<T> {
  attempts?: number;
  backoffMs?: number[];
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
    if (isPass(last) || !shouldRetry(last)) return last;
    const delay = backoffMs[i - 1];
    if (delay && delay > 0) await new Promise((r) => setTimeout(r, delay));
    last = await fn();
  }
  return last;
}

export const NVIDIA_RETRY_POLICY: RetryPolicy<TestExchange> = {
  attempts: 3,
  backoffMs: [2000, 4000],
  shouldRetry: (r) => r.status == null || r.status === 429 || r.status >= 500,
};

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function rawPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<RawResult> {
  const started = Date.now();
  try {
    // FormData (STT multipart) and ArrayBuffer (Cloudflare STT raw audio) must
    // not be JSON-stringified; fetch sets the multipart boundary itself, so drop
    // any json content-type header for FormData.
    const isForm = body instanceof FormData;
    const isBinary = body instanceof ArrayBuffer;
    const sendHeaders = isForm
      ? Object.fromEntries(
          Object.entries(headers).filter(
            ([k]) => k.toLowerCase() !== "content-type",
          ),
        )
      : headers;
    const response = await fetch(url, {
      method: "POST",
      headers: sendHeaders,
      body:
        isForm || isBinary
          ? (body as FormData | ArrayBuffer)
          : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseHeaders = headersToRecord(response.headers);
    const contentType = response.headers.get("content-type") ?? "";
    // Image-gen / TTS endpoints (Cloudflare flux/SDXL, melotts/aura) stream raw
    // PNG/JPEG/audio, not JSON. Surface a sentinel so isSuccess can accept a
    // binary 2xx instead of failing the JSON parse (which would null the response
    // and read as no-response).
    const isBinaryMedia =
      contentType.startsWith("image/") || contentType.startsWith("audio/");
    const bodyText = isBinaryMedia ? "" : await response.text();
    let data: unknown = isBinaryMedia ? { __binaryMedia: true } : null;
    if (!isBinaryMedia)
      try {
        data = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        /* non-JSON */
      }
    return {
      status: response.status,
      data,
      bodyText,
      error: response.ok
        ? null
        : `HTTP ${response.status} ${response.statusText}`,
      latencyMs: Date.now() - started,
      responseHeaders,
    };
  } catch (err) {
    return {
      status: null,
      data: null,
      bodyText: null,
      error: errMsg(err),
      latencyMs: Date.now() - started,
      responseHeaders: {},
    };
  }
}

function extractErrorMessage(data: unknown): string | null {
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
  config: RequestConfig | ToolCallRequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const raw = await rawPost(config.url, config.headers, config.body, timeoutMs);
  const request = {
    url: config.url,
    headers: config.headers,
    body: config.body,
  };
  const isTool = "isToolCallSuccess" in config;
  const isOk = isTool ? config.isToolCallSuccess : config.isSuccess;
  const fallback = isTool
    ? t("CORE.TESTER.ERR_TOOL_CALL_MISSING")
    : t("CORE.TESTER.ERR_BAD_RESPONSE");
  if (raw.data === null)
    return {
      pass: false,
      request,
      response: raw.bodyText ?? null,
      responseHeaders: raw.responseHeaders,
      error: raw.error ?? t("CORE.TESTER.ERR_NO_RESPONSE"),
      status: raw.status ?? undefined,
      latencyMs: raw.latencyMs,
    };
  const pass = raw.status !== null && raw.status < 400 && isOk(raw.data);
  return {
    pass,
    request,
    response: raw.data,
    responseHeaders: raw.responseHeaders,
    error: pass
      ? undefined
      : (raw.error ?? extractErrorMessage(raw.data) ?? fallback),
    status: raw.status ?? undefined,
    latencyMs: raw.latencyMs,
  };
}

export async function testStreamRequest(
  config: StreamRequestConfig,
  timeoutMs: number,
): Promise<TestExchange> {
  const reqInfo = {
    url: config.url,
    headers: config.headers,
    body: config.body,
  };
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const fail = (extra: Partial<TestExchange>): TestExchange => ({
    pass: false,
    request: reqInfo,
    response: null,
    responseHeaders: {},
    latencyMs: elapsed(),
    ...extra,
  });
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(config.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const respHeaders = headersToRecord(response.headers);
    if (!response.ok || !response.body) {
      const errBody = await response.text().catch(() => "");
      return fail({
        response: errBody || null,
        responseHeaders: respHeaders,
        error: t("CORE.TESTER.ERR_HTTP_STATUS", { status: response.status }),
        status: response.status,
      });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "",
      foundMarker = false;
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
        return fail({
          response: buffer.slice(0, 500),
          responseHeaders: respHeaders,
          error: t("CORE.TESTER.ERR_STREAM"),
          status: response.status,
        });
      }
    }
    return {
      pass: foundMarker,
      request: reqInfo,
      response: buffer.slice(0, 500),
      responseHeaders: respHeaders,
      error: foundMarker ? undefined : t("CORE.TESTER.ERR_STREAM_NO_MARKER"),
      status: response.status,
      latencyMs: elapsed(),
    };
  } catch (err) {
    return fail({ error: errMsg(err) });
  }
}
