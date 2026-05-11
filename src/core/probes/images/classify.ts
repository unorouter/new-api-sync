import type { ProbeErrorClass } from "./store";

const REFUSAL_PHRASES = [
  /too many (?:reference )?images?/i,
  /maximum.*(?:reference )?images?/i,
  /only (?:up to )?\d+ images? (?:are )?(?:supported|allowed)/i,
  /reference image.*not supported/i,
  /unsupported.*reference/i,
  /image.*limit.*exceeded/i,
];

const CONTENT_REFUSAL_PHRASES = [
  /i cannot|i can.?t|cannot help|unable to help|policy/i,
];

const RE_NO_CHANNEL_429 =
  /model disabled|model not found|no available channel|无可用渠道|模型已禁用|上游负载已饱和|upstream.*saturat/i;
const RE_IMAGE_REQUIRED =
  /missing required (?:key|field|parameter)|required.*image|image.*required/i;
const RE_REPLICATE_BAD = /model or version is required|invalid_request/i;
const RE_YUN_UPSTREAM = /do_response_failed|API request failed with status/i;
const RE_IMAGEN_SHAPE =
  /contents is required|Unknown name "(?:contents|instances|parts|generationConfig|safetySettings)"/i;
const RE_NO_CHANNEL_5XX =
  /无可用渠道|no available channel|distributor|无可用通道/i;
const RE_NO_CHANNEL_400 =
  /Model not found|Model does not exist|model.*not.*priced|model_price_error|does not support this api/i;
const RE_UPSTREAM_400 =
  /all_retries_failed|upstream_error|bad_response_status_code/i;

export function classifyResponse(
  status: number | undefined,
  bodyText: string | undefined,
): { errorClass: ProbeErrorClass; errorSnippet: string } {
  const errorSnippet = (bodyText ?? "").slice(0, 500);
  const ret = (errorClass: ProbeErrorClass) => ({ errorClass, errorSnippet });

  if (status === 401 || status === 403) return ret("auth");
  if (status === 429) {
    if (RE_NO_CHANNEL_429.test(errorSnippet)) return ret("no_channel");
    if (RE_IMAGE_REQUIRED.test(errorSnippet)) return ret("ref_count_rejected");
    if (RE_REPLICATE_BAD.test(errorSnippet)) return ret("ref_count_rejected");
    if (RE_YUN_UPSTREAM.test(errorSnippet)) return ret("no_channel");
    if (RE_IMAGEN_SHAPE.test(errorSnippet)) return ret("ref_count_rejected");
    return ret("ratelimit");
  }
  if (status === 404) return ret("endpoint_404");
  if (status !== undefined && status >= 500) {
    if (RE_NO_CHANNEL_5XX.test(errorSnippet)) return ret("no_channel");
    if (RE_IMAGEN_SHAPE.test(errorSnippet)) return ret("ref_count_rejected");
    return ret("timeout");
  }
  if (status === 400 || status === 422) {
    if (RE_NO_CHANNEL_400.test(errorSnippet)) return ret("no_channel");
    if (RE_UPSTREAM_400.test(errorSnippet)) return ret("no_channel");
    if (
      REFUSAL_PHRASES.some((re) => re.test(errorSnippet)) ||
      RE_IMAGE_REQUIRED.test(errorSnippet)
    ) {
      return ret("ref_count_rejected");
    }
    if (CONTENT_REFUSAL_PHRASES.some((re) => re.test(errorSnippet)))
      return ret("refusal");
    return ret("unknown");
  }
  if (status === undefined) return ret("timeout");
  return ret("unknown");
}

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
      const n = parseInt(m[m.length - 1]!, 10);
      if (!Number.isNaN(n) && n > 0 && n < 100) return n;
    }
  }
  return null;
}

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
