import type { TestExchange } from "@core/testing/types";
import { classifyResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import type { ProbeAttempt } from "./probe-sync";

export interface GenerationsProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  /** Override the URL path. When omitted, defaults to
   *  /v1/images/generations. Set this when the provider's endpointPaths
   *  declares a custom path. */
  path?: string;
  timeoutMs?: number;
}

/**
 * Probe a model via OpenAI-compatible `/v1/images/generations`. This is the
 * text-to-image surface (no reference images). When a model advertises BOTH
 * `image-generation` and `openai编辑图片` (or `image-edit`), the user wants
 * to know whether each wire shape works. We submit JSON with prompt + size,
 * no images.
 *
 * If the model also accepts an `image` field for reference-conditioned
 * generation (gpt-image-1.5 -all variants do), upstream may still bill;
 * since we send only the prompt here, we get the canonical t2i path and
 * compare it against the multipart edits path tested by probe-sync.
 */
export async function probeGenerationsChannel(
  opts: GenerationsProbeOpts,
): Promise<ProbeAttempt> {
  const url = opts.baseUrl.replace(/\/$/, "") + (opts.path ?? "/v1/images/generations");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "New-Api-User": String(opts.userId),
  };

  const body = {
    model: opts.model,
    prompt: opts.fixtures.prompt,
    n: 1,
    size: "1024x1024",
  };

  const start = performance.now();
  const ctrl = new AbortController();
  // Default 10 minutes. Image generation upstreams routinely take 2-5
   // minutes (e.g. gpt-image-2 measured at 229s on yun, billable). 90s
   // aborts healthy requests mid-flight before the upstream returns.
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 600_000);

  let resp: Response | undefined;
  let bodyText = "";
  let errorMessage: string | undefined;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
    request: { url, headers, body },
    response,
    responseHeaders,
    error: errorMessage,
    status,
    latencyMs,
  };

  if (status !== undefined && status >= 200 && status < 300) {
    if (looksLikeGenerationsOk(response, bodyText)) {
      exchange.pass = true;
      return { status: "ok", exchange };
    }
    return { status: "fail", exchange, errorClass: "refusal" };
  }

  const cls = classifyResponse(status, bodyText);
  return { status: "fail", exchange, errorClass: cls.errorClass };
}

function looksLikeGenerationsOk(parsed: unknown, raw: string): boolean {
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
