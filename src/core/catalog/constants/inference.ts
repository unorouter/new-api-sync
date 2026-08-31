import type { ModelType } from "@core/types";
import {
  ENDPOINT_KEYWORD_TYPES,
  ENDPOINT_TO_MODEL_TYPE,
  NON_TESTABLE_ENDPOINT_TYPES,
  TEXT_ENDPOINT_TYPES,
} from "./endpoints";

// prettier-ignore
const NAME_PATTERN_TYPES: [string, ModelType][] = [["dall-e","image"],["dalle","image"],["gpt-image","image"],["imagen","image"],["midjourney","image"],["mj_","image"],["mj-","image"],["stable-diffusion","image"],["sdxl","image"],["flux","image"],["deliberate","image"],["albedobase-xl","image"],["juggernaut-xl","image"],["wai-nsfw","image"],["pony-realism","image"],["nova-anime-xl","image"],["nova-furry-pony","image"],["seedream","image"],["seededit","image"],["jimeng","image"],["cogvideo","video"],["cogview","image"],["phoenix-","image"],["lucid-","image"],["dreamshaper","image"],["wan2.6-image","image"],["wan2.7-image","image"],["-t2i","image"],["-i2i","image"],["-t2i-","image"],["sora","video"],["veo","video"],["video","video"],["kling","video"],["vidu","video"],["hailuo","video"],["seedance","video"],["happyhorse","video"],["t2v-","video"],["i2v-","video"],["s2v-","video"],["-t2v","video"],["-i2v","video"],["-r2v","video"],["wan2","video"],["wanx","video"],["whisper","audio"],["tts","audio"],["speech","audio"],["text-to-speech","audio"],["speech-to-text","audio"],["eleven_","audio"],["eleven-","audio"],["scribe","audio"],["dubbing","audio"],["suno","audio"],["cosyvoice","audio"],["-asr","audio"],["fun-asr","audio"],["embeddinggemma","embedding"],["embeddings","embedding"],["embedding","embedding"],["embedder","embedding"],["embed","embedding"],["rerankers","embedding"],["reranker","embedding"],["rerank","embedding"],["bge-","embedding"],["m3e-","embedding"],["voyage-","embedding"],["image","image"]];

const NON_TEXT_MODEL_PATTERNS = NAME_PATTERN_TYPES.map(([p]) => p);

// Inflected forms are listed explicitly (embeddings/embedder, rerankers/reranker)
// because a bare-word pattern needs a boundary on BOTH sides: "embedding" does not
// match "jina-embeddings-v4" (an "s" follows), which typed 15 live embedding and
// reranker models as text. Longest form first so it wins the scan.
//
// A bare-word pattern (only [a-z0-9], no separator like '-'/'_'/'.') must match on
// a token boundary, not as a raw substring: "kling" inside "inkling" or "sora"
// inside "sorachio" is a false positive that mis-typed a text model as video/image
// (live: poolside "inkling" landed under Video). Patterns that already carry a
// separator (mj_, -i2v, wan2.6-image, gpt-image) stay plain-substring - the
// separator is the boundary. A boundary = string start/end or a non-alphanumeric.
// TRAILING DIGITS are also a boundary ("veo3.1", "sora2"): a version number does not
// make a different word, and requiring a separator left every veo3* typed as text,
// which skipped the task-adaptor override and so the per-second video billing.
// The leading side stays strict - that is what keeps "inkling" out of Video.
function matchesNamePattern(name: string, pattern: string): boolean {
  if (/[^a-z0-9]/.test(pattern)) return name.includes(pattern);
  const i = name.indexOf(pattern);
  if (i === -1) return false;
  const before = i === 0 ? "" : name[i - 1]!;
  const after = name[i + pattern.length] ?? "";
  const boundary = (c: string) => c === "" || /[^a-z0-9]/.test(c);
  return boundary(before) && (boundary(after) || /[0-9]/.test(after));
}

// Moderation classifiers serve /v1/moderations only. They used to be typed as
// image (the "moderation" name pattern), which published them as image
// generators; typing them text alone would swing them the other way and list
// them as chat models. Neither is right, so they are pinned to their own
// endpoint instead. Guard/safeguard models are deliberately NOT here: those are
// fine-tuned LLMs that answer over chat completions.
export function isModerationModel(name: string): boolean {
  return /(^|[^a-z0-9])moderations?([^a-z0-9]|$)/.test(name.toLowerCase());
}

function inferModelTypeFromName(name: string): ModelType {
  const n = name.toLowerCase();
  for (const [pattern, type] of NAME_PATTERN_TYPES) {
    if (matchesNamePattern(n, pattern)) return type;
  }
  return "text";
}

export function inferModelType(
  name: string,
  endpoints?: string[],
  modelEndpoints?: Map<string, string[]>,
): ModelType {
  const eps = endpoints ?? modelEndpoints?.get(name);
  if (eps) {
    for (const ep of eps) {
      const exact = ENDPOINT_TO_MODEL_TYPE[ep];
      if (exact) return exact;
    }
    for (const ep of eps) {
      const lower = ep.toLowerCase();
      for (const [keyword, type] of ENDPOINT_KEYWORD_TYPES) {
        if (lower.includes(keyword)) return type;
      }
    }
  }
  return inferModelTypeFromName(name);
}

export function isTestableModel(
  name: string,
  endpoints?: string[],
  modelEndpoints?: Map<string, string[]>,
): boolean {
  if (isModerationModel(name)) return false;
  const eps = endpoints ?? modelEndpoints?.get(name);
  if (eps && eps.length > 0) {
    if (eps.some((ep) => NON_TESTABLE_ENDPOINT_TYPES.has(ep))) return false;
    if (eps.some((ep) => TEXT_ENDPOINT_TYPES.has(ep))) {
      return inferModelTypeFromName(name) === "text";
    }
  }
  const n = name.toLowerCase();
  return !NON_TEXT_MODEL_PATTERNS.some((p) => matchesNamePattern(n, p));
}
