import type { ModelType } from "@core/types";
import {
  ENDPOINT_KEYWORD_TYPES,
  ENDPOINT_TO_MODEL_TYPE,
  NON_TESTABLE_ENDPOINT_TYPES,
  TEXT_ENDPOINT_TYPES,
} from "./endpoints";

// prettier-ignore
const NAME_PATTERN_TYPES: [string, ModelType][] = [["dall-e","image"],["dalle","image"],["gpt-image","image"],["imagen","image"],["midjourney","image"],["mj_","image"],["mj-","image"],["stable-diffusion","image"],["flux","image"],["seedream","image"],["seededit","image"],["jimeng","image"],["phoenix-","image"],["lucid-","image"],["dreamshaper","image"],["wan2.6-image","image"],["wan2.7-image","image"],["-t2i","image"],["-i2i","image"],["-t2i-","image"],["sora","video"],["veo","video"],["video","video"],["kling","video"],["vidu","video"],["hailuo","video"],["seedance","video"],["happyhorse","video"],["t2v-","video"],["i2v-","video"],["s2v-","video"],["-t2v","video"],["-i2v","video"],["-r2v","video"],["wan2","video"],["wanx","video"],["whisper","audio"],["tts","audio"],["speech","audio"],["text-to-speech","audio"],["speech-to-text","audio"],["eleven_","audio"],["eleven-","audio"],["scribe","audio"],["dubbing","audio"],["suno","audio"],["cosyvoice","audio"],["-asr","audio"],["fun-asr","audio"],["embedding","embedding"],["embed","embedding"],["rerank","embedding"],["bge-","embedding"],["m3e-","embedding"],["voyage-","embedding"],["image","image"],["moderation","image"]];

const NON_TEXT_MODEL_PATTERNS = NAME_PATTERN_TYPES.map(([p]) => p);

function inferModelTypeFromName(name: string): ModelType {
  const n = name.toLowerCase();
  for (const [pattern, type] of NAME_PATTERN_TYPES) {
    if (n.includes(pattern)) return type;
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
  return !NON_TEXT_MODEL_PATTERNS.some((p) => n.includes(p));
}
