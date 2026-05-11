import type { TestExchange } from "@core/testing/types";
import { buildBody } from "./body-builder";
import { classifyResponse, looksLikeImageResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import type { ProbeErrorClass } from "./store";

export interface ChannelProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  path?: string;
  timeoutMs?: number;
}
const stripSlash = (u: string) => u.replace(/\/$/, "");
const oaiHeaders = (apiKey: string, userId: number, json = true) => {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "New-Api-User": String(userId),
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
};

export interface ProbeAttempt {
  status: "ok" | "fail";
  exchange: TestExchange;
  errorClass?: ProbeErrorClass;
  taskId?: string;
}

export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: FormData | Record<string, unknown>;
  sanitizedBody: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ProbeSuccess {
  isImage(parsed: unknown, raw: string): boolean;
}

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
  if (resp) for (const [k, v] of resp.headers.entries()) responseHeaders[k] = v;

  let response: unknown = bodyText;
  try {
    response = JSON.parse(bodyText);
  } catch {}

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

export const isOpenAiImageOk: ProbeSuccess = {
  isImage(parsed, raw) {
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      if (Array.isArray(o.data)) {
        const first = o.data[0] as Record<string, unknown> | undefined;
        if (
          first &&
          (typeof first.url === "string" || typeof first.b64_json === "string")
        )
          return true;
      }
    }
    return /\b(?:url|b64_json)\b/.test(raw);
  },
};

const isImageInChatResponse: ProbeSuccess = {
  isImage: (_parsed, raw) => looksLikeImageResponse(raw),
};

export async function probeGenerationsChannel(
  opts: ChannelProbeOpts,
): Promise<ProbeAttempt> {
  const body = {
    model: opts.model,
    prompt: opts.fixtures.prompt,
    n: 1,
    size: "1024x1024",
  };
  return probe(
    {
      url: stripSlash(opts.baseUrl) + (opts.path ?? "/v1/images/generations"),
      headers: oaiHeaders(opts.apiKey, opts.userId),
      body,
      sanitizedBody: body,
      timeoutMs: opts.timeoutMs,
    },
    isOpenAiImageOk,
  );
}

export async function probeSyncChannel(
  opts: ChannelProbeOpts,
): Promise<ProbeAttempt> {
  const fd = new FormData();
  fd.set("model", opts.model);
  fd.set("prompt", opts.fixtures.prompt);
  fd.set("n", "1");
  fd.set("size", "1024x1024");
  for (const file of opts.fixtures.files) fd.append("image[]", file, file.name);
  return probe(
    {
      url: stripSlash(opts.baseUrl) + (opts.path ?? "/v1/images/edits"),
      headers: oaiHeaders(opts.apiKey, opts.userId, false),
      body: fd,
      sanitizedBody: {
        model: opts.model,
        prompt: opts.fixtures.prompt,
        n: 1,
        size: "1024x1024",
        fixtures: opts.fixtures.files.map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type,
        })),
      },
      timeoutMs: opts.timeoutMs,
    },
    isOpenAiImageOk,
  );
}

export async function probeOpenAiVendorChannel(
  opts: ChannelProbeOpts,
): Promise<ProbeAttempt> {
  const headers = oaiHeaders(opts.apiKey, opts.userId);
  const built = opts.path
    ? buildBody({ path: opts.path, model: opts.model, fixtures: opts.fixtures })
    : null;
  let body: Record<string, unknown>;
  let sanitizedBody: Record<string, unknown>;
  if (built) {
    body = built.body as Record<string, unknown>;
    sanitizedBody = built.bodyMeta;
    if (built.extraHeaders)
      for (const [k, v] of Object.entries(built.extraHeaders)) headers[k] = v;
  } else {
    const content = [
      ...opts.fixtures.dataUris.map((uri) => ({
        type: "image_url" as const,
        image_url: { url: uri },
      })),
      { type: "text" as const, text: opts.fixtures.prompt },
    ];
    body = { model: opts.model, messages: [{ role: "user", content }] };
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
  return probe(
    {
      url: stripSlash(opts.baseUrl) + (opts.path ?? "/v1/chat/completions"),
      headers,
      body,
      sanitizedBody,
      timeoutMs: opts.timeoutMs,
    },
    isImageInChatResponse,
  );
}
