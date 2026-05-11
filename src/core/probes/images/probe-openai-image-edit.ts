import { buildBody } from "./body-builder";
import { looksLikeImageResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import { probe, type ProbeAttempt, type ProbeSuccess } from "./probe";

export interface OpenAiVendorProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  path?: string;
  timeoutMs?: number;
}

const isImageInChatResponse: ProbeSuccess = {
  isImage: (_parsed, raw) => looksLikeImageResponse(raw),
};

/**
 * Chat-completions multimodal: 6 image parts as data URIs + text prompt.
 * Most "task family" models on aigc/yun (kling-v3-omni, mj_edits,
 * qwen-image-edit-plus, doubao-seedream, nano-banana-pro-preview) route
 * through this surface; new-api translates the OAI body to the vendor's
 * native shape inside its channel adaptors.
 *
 * When `path` matches a vendor-native chat-shaped path (Gemini
 * `:generateContent` etc.), buildBody returns the vendor body; otherwise
 * we send the OAI chat-completions default.
 */
export async function probeOpenAiVendorChannel(
  opts: OpenAiVendorProbeOpts,
): Promise<ProbeAttempt> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "New-Api-User": String(opts.userId),
  };

  const built = opts.path
    ? buildBody({ path: opts.path, model: opts.model, fixtures: opts.fixtures })
    : null;

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
      url:
        opts.baseUrl.replace(/\/$/, "") + (opts.path ?? "/v1/chat/completions"),
      headers,
      body,
      sanitizedBody,
      timeoutMs: opts.timeoutMs,
    },
    isImageInChatResponse,
  );
}
