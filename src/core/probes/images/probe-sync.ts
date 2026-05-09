import type { TestExchange } from "@core/testing/types";
import { classifyResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import type { ProbeErrorClass } from "./store";

/**
 * Probe attempt result. Carries the raw exchange (request/response) and a
 * classified error class on failure.
 */
export interface ProbeAttempt {
  status: "ok" | "fail";
  exchange: TestExchange;
  errorClass?: ProbeErrorClass;
  taskId?: string;
}

export interface SyncProbeOpts {
  baseUrl: string;
  /** Per-user inference API key (NOT the systemAccessToken). */
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  /** Override the URL path. When omitted, defaults to /v1/images/edits.
   *  Set this when the provider's endpointPaths declares a custom path
   *  for the edit endpoint (e.g. yun's `/replicate/v1/.../predictions`
   *  for Replicate-routed channels). */
  path?: string;
  /** Default 10 minutes. Image gen routinely takes 2-5 minutes upstream
   *  (gpt-image-2 measured at 229s on yun, billable). 90s aborts healthy
   *  requests mid-flight - matches the task probe's poll budget. */
  timeoutMs?: number;
}

/**
 * Probe a model via OpenAI-compatible `/v1/images/edits`. Submits all 6
 * fixture JPEGs as `image[]` form fields plus the shared text prompt.
 * `New-Api-User: <userId>` mirrors admin context.
 */
export async function probeSyncChannel(
  opts: SyncProbeOpts,
): Promise<ProbeAttempt> {
  const url = opts.baseUrl.replace(/\/$/, "") + (opts.path ?? "/v1/images/edits");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "New-Api-User": String(opts.userId),
  };
  const fd = new FormData();
  fd.set("model", opts.model);
  fd.set("prompt", opts.fixtures.prompt);
  fd.set("n", "1");
  fd.set("size", "1024x1024");
  for (const file of opts.fixtures.files) {
    fd.append("image[]", file, file.name);
  }

  const start = performance.now();
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let resp: Response | undefined;
  let bodyText = "";
  let errorMessage: string | undefined;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: fd,
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

  // Body metadata only — never include the raw fixture bytes in the artifact.
  const requestBodyMeta = {
    model: opts.model,
    prompt: opts.fixtures.prompt,
    n: 1,
    size: "1024x1024",
    fixtures: opts.fixtures.files.map((f) => ({
      name: f.name,
      size: f.size,
      type: f.type,
    })),
  };

  // Try to parse JSON for richer downstream inspection; fall back to raw.
  let response: unknown = bodyText;
  try {
    response = JSON.parse(bodyText);
  } catch {
    /* not JSON; keep bodyText */
  }

  const exchange: TestExchange = {
    pass: false,
    request: { url, headers, body: requestBodyMeta },
    response,
    responseHeaders,
    error: errorMessage,
    status,
    latencyMs,
  };

  // Pass: 2xx with at least one image url / b64_json in the response.
  if (status !== undefined && status >= 200 && status < 300) {
    if (looksLikeImageEditOk(response, bodyText)) {
      exchange.pass = true;
      return { status: "ok", exchange };
    }
    // 200 with no usable image — treat as refusal so the user can inspect.
    return {
      status: "fail",
      exchange,
      errorClass: "refusal",
    };
  }

  const cls = classifyResponse(status, bodyText);
  return {
    status: "fail",
    exchange,
    errorClass: cls.errorClass,
  };
}

function looksLikeImageEditOk(parsed: unknown, raw: string): boolean {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.data)) {
      const first = o.data[0] as Record<string, unknown> | undefined;
      if (first && (typeof first.url === "string" || typeof first.b64_json === "string")) {
        return true;
      }
    }
  }
  return /\b(?:url|b64_json)\b/.test(raw);
}
