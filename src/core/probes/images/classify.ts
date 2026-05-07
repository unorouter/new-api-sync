import type { ProbeErrorClass } from "./store";

/**
 * Refusal phrases observed in upstream provider responses when they reject
 * a multi-reference image edit. Compared case-insensitively against body
 * text. Order doesn't matter — any match wins.
 */
const REFUSAL_PHRASES = [
  /too many (?:reference )?images?/i,
  /maximum.*(?:reference )?images?/i,
  /only (?:up to )?\d+ images? (?:are )?(?:supported|allowed)/i,
  /reference image.*not supported/i,
  /unsupported.*reference/i,
  /image.*limit.*exceeded/i,
];

/**
 * Phrases the upstream emits when the model itself refuses (content moderation
 * etc.) rather than rejecting the ref-count specifically.
 */
const CONTENT_REFUSAL_PHRASES = [
  /i cannot|i can.?t|cannot help|unable to help|policy/i,
];

export function classifyResponse(
  status: number | undefined,
  bodyText: string | undefined,
): { errorClass: ProbeErrorClass; errorSnippet: string } {
  const snippet = (bodyText ?? "").slice(0, 500);

  if (status === 401 || status === 403) {
    return { errorClass: "auth", errorSnippet: snippet };
  }
  if (status === 429) {
    return { errorClass: "ratelimit", errorSnippet: snippet };
  }
  if (status === 404) {
    return { errorClass: "endpoint_404", errorSnippet: snippet };
  }
  if (status !== undefined && status >= 500) {
    return { errorClass: "timeout", errorSnippet: snippet };
  }
  if (status === 400 || status === 422) {
    if (REFUSAL_PHRASES.some((re) => re.test(snippet))) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    if (CONTENT_REFUSAL_PHRASES.some((re) => re.test(snippet))) {
      return { errorClass: "refusal", errorSnippet: snippet };
    }
    return { errorClass: "ref_count_rejected", errorSnippet: snippet };
  }
  if (status === undefined) {
    return { errorClass: "timeout", errorSnippet: snippet };
  }
  return { errorClass: "unknown", errorSnippet: snippet };
}

/**
 * For 200 responses on the openai-vendor path: text-only assistant content
 * is a refusal (model refused to generate or just talked at the user). An
 * image URL or base64 in the response means it actually produced an image.
 */
export function looksLikeImageResponse(bodyText: string): boolean {
  // Common shapes:
  //   1. JSON with data[].url or b64_json (OAI image-edit)
  //   2. Chat-completions assistant message containing image_url part
  //   3. Markdown with ![](https://...png) or data: URI
  //   4. Bare URL in plain text
  return (
    /\bb64_json\b/.test(bodyText) ||
    /\bimage_url\b/.test(bodyText) ||
    /\bdata:image\/(?:png|jpe?g|webp|gif)/i.test(bodyText) ||
    /https?:\/\/[^\s"']+\.(?:png|jpe?g|webp|gif)/i.test(bodyText)
  );
}
