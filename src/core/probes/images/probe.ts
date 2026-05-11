import type { TestExchange } from "@core/testing/types";
import { classifyResponse } from "./classify";
import type { ProbeErrorClass } from "./store";

export interface ProbeAttempt {
  status: "ok" | "fail";
  exchange: TestExchange;
  errorClass?: ProbeErrorClass;
  taskId?: string;
}

export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  /** Sent body. FormData → multipart; object → JSON. */
  body: FormData | Record<string, unknown>;
  /** Body shape to record in the artifact (without raw fixture bytes / data URIs). */
  sanitizedBody: Record<string, unknown>;
  /** Default 10 minutes. Image gen takes 2-5 minutes upstream (gpt-image-2 measured 229s on yun). */
  timeoutMs?: number;
}

export interface ProbeSuccess {
  /** Inspect 2xx response: did the upstream actually return an image? */
  isImage(parsed: unknown, raw: string): boolean;
}

/**
 * Shared probe shell: build request → fetch with timeout → record exchange →
 * classify on failure. The five image-probe shapes differ only in URL, body,
 * and `isImage` predicate; everything else (latency, headers capture, JSON
 * parse fallback, refusal-on-200, error classification) lives here.
 */
export async function probe(
  req: ProbeRequest,
  isSuccess: ProbeSuccess,
): Promise<ProbeAttempt> {
  const start = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 600_000);

  let resp: Response | undefined;
  let bodyText = "";
  let errorMessage: string | undefined;
  try {
    resp = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body instanceof FormData ? req.body : JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    bodyText = await resp.text();
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.round(performance.now() - start);

  const status = resp?.status;
  const responseHeaders: Record<string, string> = {};
  if (resp) {
    for (const [k, v] of resp.headers.entries()) responseHeaders[k] = v;
  }

  let response: unknown = bodyText;
  try {
    response = JSON.parse(bodyText);
  } catch {
    /* keep raw */
  }

  const exchange: TestExchange = {
    pass: false,
    request: { url: req.url, headers: req.headers, body: req.sanitizedBody },
    response,
    responseHeaders,
    error: errorMessage,
    status,
    latencyMs,
  };

  if (status !== undefined && status >= 200 && status < 300) {
    if (isSuccess.isImage(response, bodyText)) {
      exchange.pass = true;
      return { status: "ok", exchange };
    }
    return { status: "fail", exchange, errorClass: "refusal" };
  }

  return {
    status: "fail",
    exchange,
    errorClass: classifyResponse(status, bodyText).errorClass,
  };
}

/** OpenAI image shape: data[0].url or data[0].b64_json. Used by sync-edits and sync-generations. */
export const isOpenAiImageOk: ProbeSuccess = {
  isImage(parsed, raw) {
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      if (Array.isArray(o.data)) {
        const first = o.data[0] as Record<string, unknown> | undefined;
        if (
          first &&
          (typeof first.url === "string" || typeof first.b64_json === "string")
        ) {
          return true;
        }
      }
    }
    return /\b(?:url|b64_json)\b/.test(raw);
  },
};
