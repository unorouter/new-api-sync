import type { ProbeErrorClass } from "./store";

/** Multi-ref rejection phrases. */
const REFUSAL_PHRASES = [
  /too many (?:reference )?images?/i,
  /maximum.*(?:reference )?images?/i,
  /only (?:up to )?\d+ images? (?:are )?(?:supported|allowed)/i,
  /reference image.*not supported/i,
  /unsupported.*reference/i,
  /image.*limit.*exceeded/i,
];

/** Content-moderation refusals (distinct from ref-count). */
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
    // 429 is overloaded by new-api gateways: rate limit, model disabled,
    // bad body shape, upstream saturated. Surface non-rate-limit cases so
    // the retry loop skips them.
    if (
      /model disabled|model not found|no available channel|无可用渠道|模型已禁用|上游负载已饱和|upstream.*saturat/i.test(
        snippet,
      )
    ) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    if (
      /missing required (?:key|field|parameter)|required.*image|image.*required/i.test(
        snippet,
      )
    ) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    // bare /replicate/v1/predictions without a model version UUID
    if (/model or version is required|invalid_request/i.test(snippet)) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    // yun wraps Replicate 5xx as 429 — upstream outage, not our limit.
    if (/do_response_failed|API request failed with status/i.test(snippet)) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    // Imagen on aigc: gateway can't translate to :predict (returns 429).
    if (
      /contents is required|Unknown name "(?:contents|instances|parts|generationConfig|safetySettings)"/i.test(
        snippet,
      )
    ) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    return { errorClass: "ratelimit", errorSnippet: snippet };
  }
  if (status === 404) {
    return { errorClass: "endpoint_404", errorSnippet: snippet };
  }
  if (status !== undefined && status >= 500) {
    // Pricing listed but no backend wired.
    if (
      /无可用渠道|no available channel|distributor|无可用通道/i.test(snippet)
    ) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    // Imagen :predict mismatch (see 429 case above).
    if (
      /contents is required|Unknown name "(?:contents|instances|parts|generationConfig|safetySettings)"/i.test(
        snippet,
      )
    ) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    return { errorClass: "timeout", errorSnippet: snippet };
  }
  if (status === 400 || status === 422) {
    if (
      /Model not found|Model does not exist|model.*not.*priced|model_price_error|does not support this api/i.test(
        snippet,
      )
    ) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    if (
      /all_retries_failed|upstream_error|bad_response_status_code/i.test(
        snippet,
      )
    ) {
      return { errorClass: "no_channel", errorSnippet: snippet };
    }
    // Triggers downshift / wire-shape retry. "Missing required key: image" appears here on some forks, 429 on others.
    if (
      REFUSAL_PHRASES.some((re) => re.test(snippet)) ||
      /missing required (?:key|field|parameter)|required.*image|image.*required/i.test(
        snippet,
      )
    ) {
      return { errorClass: "ref_count_rejected", errorSnippet: snippet };
    }
    if (CONTENT_REFUSAL_PHRASES.some((re) => re.test(snippet))) {
      return { errorClass: "refusal", errorSnippet: snippet };
    }
    return { errorClass: "unknown", errorSnippet: snippet };
  }
  if (status === undefined) {
    return { errorClass: "timeout", errorSnippet: snippet };
  }
  return { errorClass: "unknown", errorSnippet: snippet };
}

/** Extract max image count from rejection: "must contain 1~3 image items. Got 6", "Maximum 4 reference images", "only up to 2 images", etc. */
export function extractMaxImagesFromRejection(
  bodyText: string | undefined,
): number | null {
  if (!bodyText) return null;
  const ranges = [
    /(\d+)\s*[~\-]\s*(\d+)\s*image[\s-]?(?:content)?\s*items?/i,
    /between\s+\d+\s+and\s+(\d+)/i,
    /maximum\s+(?:of\s+)?(\d+)\s*(?:reference\s*)?images?/i,
    /only\s+(?:up\s+to\s+)?(\d+)\s*images?/i,
    /at\s+most\s+(\d+)\s*images?/i,
  ];
  for (const re of ranges) {
    const m = bodyText.match(re);
    if (m) {
      const last = m[m.length - 1];
      const n = parseInt(last!, 10);
      if (!Number.isNaN(n) && n > 0 && n < 100) return n;
    }
  }
  return null;
}

/** 200 with no image = the model talked at us; treat as refusal upstream. Matches OAI data[], chat image_url, markdown ![](), data: URIs, Gemini inlineData. */
export function looksLikeImageResponse(bodyText: string): boolean {
  return (
    /\bb64_json\b/.test(bodyText) ||
    /\bimage_url\b/.test(bodyText) ||
    /\bdata:image\/(?:png|jpe?g|webp|gif)/i.test(bodyText) ||
    /https?:\/\/[^\s"']+\.(?:png|jpe?g|webp|gif)/i.test(bodyText) ||
    /"inline_?[Dd]ata"\s*:\s*\{[^}]*"(?:mime_?[Tt]ype)"\s*:\s*"image\//.test(
      bodyText,
    ) ||
    /!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/.test(bodyText)
  );
}
