import type { TestExchange } from "@core/testing/types";
import { buildBody } from "./body-builder";
import { classifyResponse, looksLikeImageResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import type { ProbeAttempt } from "./probe-sync";

export interface OpenAiVendorProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  /** Override the URL path. When omitted, defaults to
   *  /v1/chat/completions. Used for native gemini paths
   *  (`/v1beta/models/{model}:generateContent`) when the provider's
   *  endpointPaths declares them. */
  path?: string;
  timeoutMs?: number;
}

/**
 * Probe a model whose only exposed endpoint is `openai` (chat-completions).
 * Most "task family" models on aigc/yun are actually routed through this
 * surface — kling-v3-omni, mj_edits, qwen-image-edit-plus, doubao-seedream,
 * nano-banana-pro-preview, etc. New-api translates the chat-completions
 * shape into the vendor's native body inside its channel adaptors.
 *
 * Strategy: 6 image parts as data URIs in a single user message + text part
 * carrying the shared prompt. Pass = response contains an image URL or
 * base64 image (heuristic in classify.looksLikeImageResponse).
 */
export async function probeOpenAiVendorChannel(
  opts: OpenAiVendorProbeOpts,
): Promise<ProbeAttempt> {
  const url = opts.baseUrl.replace(/\/$/, "") + (opts.path ?? "/v1/chat/completions");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "New-Api-User": String(opts.userId),
  };

  // Pick body shape from the URL path. Vendor-native chat-shaped paths
  // (Gemini `:generateContent`, Anthropic `/v1/messages`) need their own
  // multimodal schema; the OAI chat-completions default falls through
  // when no vendor match (the new-api translation layer handles
  // openai-shaped bodies on most channels).
  const built = opts.path ? buildBody({ path: opts.path, model: opts.model, fixtures: opts.fixtures }) : null;
  let body: Record<string, unknown>;
  let sanitizedBody: Record<string, unknown>;
  if (built) {
    body = built.body as Record<string, unknown>;
    sanitizedBody = built.bodyMeta;
    if (built.extraHeaders) {
      for (const [k, v] of Object.entries(built.extraHeaders)) headers[k] = v;
    }
  } else {
    const content = [
      ...opts.fixtures.dataUris.map((uri) => ({
        type: "image_url" as const,
        image_url: { url: uri },
      })),
      { type: "text" as const, text: opts.fixtures.prompt },
    ];
    body = {
      model: opts.model,
      messages: [{ role: "user", content }],
    };
    sanitizedBody = {
      model: opts.model,
      messages: [
        {
          role: "user",
          content: [
            `[${opts.fixtures.dataUris.length} DATA_URI_REDACTED parts]`,
            { type: "text", text: opts.fixtures.prompt },
          ],
        },
      ],
    };
  }

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
    request: { url, headers, body: sanitizedBody },
    response,
    responseHeaders,
    error: errorMessage,
    status,
    latencyMs,
  };

  if (status !== undefined && status >= 200 && status < 300) {
    if (looksLikeImageResponse(bodyText)) {
      exchange.pass = true;
      return { status: "ok", exchange };
    }
    return { status: "fail", exchange, errorClass: "refusal" };
  }

  const cls = classifyResponse(status, bodyText);
  return { status: "fail", exchange, errorClass: cls.errorClass };
}
