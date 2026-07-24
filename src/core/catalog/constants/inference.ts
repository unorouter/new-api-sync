import type { ModelType } from "@core/types";
import {
  ENDPOINT_KEYWORD_TYPES,
  ENDPOINT_TO_MODEL_TYPE,
  NON_TESTABLE_ENDPOINT_TYPES,
  TEXT_ENDPOINT_TYPES,
} from "./endpoints";

// prettier-ignore
const NAME_PATTERN_TYPES: [string, ModelType][] = [["dall-e","image"],["dalle","image"],["gpt-image","image"],["imagen","image"],["midjourney","image"],["mj_","image"],["mj-","image"],["stable-diffusion","image"],["sdxl","image"],["flux","image"],["deliberate","image"],["albedobase-xl","image"],["juggernaut-xl","image"],["wai-nsfw","image"],["pony-realism","image"],["nova-anime-xl","image"],["nova-furry-pony","image"],["seedream","image"],["seededit","image"],["jimeng","image"],["phoenix-","image"],["lucid-","image"],["dreamshaper","image"],["wan2.6-image","image"],["wan2.7-image","image"],["-t2i","image"],["-i2i","image"],["-t2i-","image"],["sora","video"],["veo","video"],["video","video"],["kling","video"],["vidu","video"],["hailuo","video"],["seedance","video"],["happyhorse","video"],["t2v-","video"],["i2v-","video"],["s2v-","video"],["-t2v","video"],["-i2v","video"],["-r2v","video"],["wan2","video"],["wanx","video"],["whisper","audio"],["tts","audio"],["speech","audio"],["text-to-speech","audio"],["speech-to-text","audio"],["eleven_","audio"],["eleven-","audio"],["scribe","audio"],["dubbing","audio"],["suno","audio"],["cosyvoice","audio"],["-asr","audio"],["fun-asr","audio"],["embedding","embedding"],["embed","embedding"],["rerank","embedding"],["bge-","embedding"],["m3e-","embedding"],["voyage-","embedding"],["image","image"],["moderation","image"]];

const NON_TEXT_MODEL_PATTERNS = NAME_PATTERN_TYPES.map(([p]) => p);

// A bare-word pattern (only [a-z0-9], no separator like '-'/'_'/'.') must match on
// a token boundary, not as a raw substring: "kling" inside "inkling" or "sora"
// inside "sorachio" is a false positive that mis-typed a text model as video/image
// (live: poolside "inkling" landed under Video). Patterns that already carry a
// separator (mj_, -i2v, wan2.6-image, gpt-image) stay plain-substring - the
// separator is the boundary. A boundary = string start/end or a non-alphanumeric.
function matchesNamePattern(name: string, pattern: string): boolean {
  if (/[^a-z0-9]/.test(pattern)) return name.includes(pattern);
  const i = name.indexOf(pattern);
  if (i === -1) return false;
  const before = i === 0 ? "" : name[i - 1]!;
  const after = name[i + pattern.length] ?? "";
  const boundary = (c: string) => c === "" || /[^a-z0-9]/.test(c);
  return boundary(before) && boundary(after);
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
