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
    // new-api gateways frequently return HTTP 429 as a generic "deny"
    // code instead of a real rate-limit. The body distinguishes:
    //
    //   - "Model disabled" / "无可用渠道" / "model not found"
    //       -> deterministic: model + group combo unavailable.
    //   - "Missing required key: image" / "missing field"
    //       -> request shape is wrong (e.g. probed sync-generations on
    //          an edit-only model). Retrying with same body is pointless.
    //   - "上游负载已饱和" (upstream saturated)
    //       -> upstream-side capacity, not OUR rate limit. Some gateways
    //          bill per attempt regardless of this outcome, so retrying
    //          can drain quota for nothing.
    //
    // Surface all of these as `no_channel` / `refusal` so the retry
    // loop skips them and we don't hammer the upstream.
    if (/model disabled|model not found|no available channel|无可用渠道|模型已禁用|上游负载已饱和|upstream.*saturat/i.test(snippet)) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    if (/missing required (?:key|field|parameter)|required.*image|image.*required/i.test(snippet)) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    // Replicate-style "model or version is required": we hit a bare
    // /predictions path without supplying the model version UUID.
    // Deterministic body-shape error, not a rate limit.
    if (/model or version is required|invalid_request/i.test(snippet)) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    // Upstream relay failure: yun wraps Replicate 5xx as 429 with body
    // `{code: "do_response_failed", message: "API request failed with
    // status: 503"}`. Real upstream-side outage, not our rate limit -
    // retrying just hammers a downed Replicate. Treat as transient
    // upstream failure (no_channel) so the retry loop skips and we move
    // to the next group/model.
    if (/do_response_failed|API request failed with status/i.test(snippet)) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    // Body-shape impedance mismatch (e.g. Imagen on aigc declares the
    // gemini endpoint but the model itself wants :predict shape).
    // Wrapped as 429 by aigc; treat as ref_count_rejected so the loop
    // skips (no point retrying with the same wrong body).
    if (/contents is required|Unknown name "(?:contents|instances|parts|generationConfig)"/i.test(snippet)) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
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
    // Gateway misconfiguration: Imagen-style models advertised under
    // `gemini` endpoint type but the gateway translation expects Gemini
    // multimodal body shape. Imagen rejects with "contents is required"
    // (when hit on /v1/images/generations) or "Unknown name 'contents'"
    // / "Unknown name 'instances'" (when hit on :generateContent vs
    // :predict mismatch). Either way it's a body-shape impedance
    // mismatch we can't resolve without per-model wire knowledge.
    if (/contents is required|Unknown name "(?:contents|instances|parts|generationConfig)"/i.test(snippet)) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
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
  //   5. Gemini-native: candidates[].content.parts[].inlineData.{mimeType,data}.
  //      The base64 sits in a bare `data` field with a sibling `mimeType`
  //      (or `mime_type`) - no `data:` prefix. We match the inlineData
  //      wrapper since the field names are stable and unique to Gemini.
  return (
    /\bb64_json\b/.test(bodyText) ||
    /\bimage_url\b/.test(bodyText) ||
    /\bdata:image\/(?:png|jpe?g|webp|gif)/i.test(bodyText) ||
    /https?:\/\/[^\s"']+\.(?:png|jpe?g|webp|gif)/i.test(bodyText) ||
    /"inline_?[Dd]ata"\s*:\s*\{[^}]*"(?:mime_?[Tt]ype)"\s*:\s*"image\//.test(bodyText)
  );
}
