import type { TestExchange } from "@core/testing/types";
import { classifyResponse, looksLikeImageResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import type { ProbeAttempt } from "./probe-sync";

export interface OpenAiVendorProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  channelId: number;
  model: string;
  fixtures: Fixtures;
  /** Override the URL path. When omitted, defaults to
   *  /v1/chat/completions. Used for native gemini/anthropic paths when
   *  the provider's endpointPaths declares them. */
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
  if (opts.channelId > 0) {
    headers["Specify-Channel"] = String(opts.channelId);
  }

  const content = [
    ...opts.fixtures.dataUris.map((uri) => ({
      type: "image_url" as const,
      image_url: { url: uri },
    })),
    { type: "text" as const, text: opts.fixtures.prompt },
  ];

  const body = {
    model: opts.model,
    messages: [{ role: "user", content }],
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

  // Strip the data URIs from the saved request body to keep artifacts small.
  const sanitizedBody = {
    ...body,
    messages: body.messages.map((m) => ({
      ...m,
      content: m.content.map((c) =>
        c.type === "image_url"
          ? {
              type: "image_url",
              image_url: { url: "[DATA_URI_REDACTED]" },
            }
          : c,
      ),
    })),
  };

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
