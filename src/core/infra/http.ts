import { FetchError, ofetch } from "ofetch";
import { t } from "@server/i18n";

// ─── Raw request (probes + testing) ───────────────────────────────────────
// One shape for every wire test. JSON parse is best-effort; bodyText is always
// kept for diagnostics. fetchJson/tryFetchJson stay separate (ofetch-backed)
// for the vendor clients that need its retry/JSON-forcing semantics.

export interface RawRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: FormData | Record<string, unknown> | string;
  timeoutMs?: number;
}

export interface RawResponse {
  status?: number;
  headers: Record<string, string>;
  data: unknown;
  bodyText: string;
  error?: string;
  latencyMs: number;
}

export async function request(req: RawRequest): Promise<RawResponse> {
  const started = Date.now();
  const timeoutMs = req.timeoutMs ?? 30_000;
  const method = req.method ?? "POST";
  const headers = req.headers ?? {};
  const body = serializeBody(req.body, headers);
  try {
    const resp = await fetch(req.url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyText = await resp.text();
    let data: unknown = bodyText;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      /* keep bodyText */
    }
    return {
      status: resp.status,
      headers: headersToRecord(resp.headers),
      data,
      bodyText,
      error: resp.ok ? undefined : `HTTP ${resp.status} ${resp.statusText}`,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      status: undefined,
      headers: {},
      data: null,
      bodyText: "",
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

function serializeBody(
  body: RawRequest["body"],
  headers: Record<string, string>,
): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof FormData) return body;
  if (!headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  return JSON.stringify(body);
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

// ─── JSON convenience (vendor clients) ────────────────────────────────────

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
