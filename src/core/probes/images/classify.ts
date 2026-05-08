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
    // new-api gateways sometimes return HTTP 429 as a generic "deny"
    // code, not a real rate-limit. Body strings like "Model disabled",
    // "model not found", "no available channel" mean the upstream
    // permanently refuses this model + group combo - retrying is not
    // only useless but actively harmful (some upstreams bill per
    // attempt regardless of outcome). Surface those as no_channel /
    // refusal so the retry loop skips them.
    if (/model disabled|model not found|no available channel|无可用渠道|模型已禁用/i.test(snippet)) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    return { errorClass: "ratelimit", errorSnippet: snippet };
  }
  if (status === 404) {
    return { errorClass: "endpoint_404", errorSnippet: snippet };
  }
  if (status !== undefined && status >= 500) {
    // new-api gateways short-circuit with 503 + a "no available channel"
    // message when the model is listed in pricing but has no backend
    // wired up. Surface this distinctly so the user can prune their
    // enabledModels list - the model isn't broken, the upstream just
    // doesn't actually serve it.
    if (
      /无可用渠道|no available channel|distributor|无可用通道/i.test(snippet)
    ) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
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
