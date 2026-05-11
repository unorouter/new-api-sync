import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { buildBody } from "../body-builder";
import { canonicalize, pickRepresentative } from "../canonicalize";
import { resolveEndpoint, SHARED_OAI_PATHS } from "../endpoint-resolver";
import type { Fixtures } from "../io/fixtures";

export type ProbeKind = "sync" | "openai-vendor" | "task";

export interface Candidate {
  providerName: string;
  modelName: string;
  canonicalKey: string;
  kind: ProbeKind;
  endpointTypes: string[];
  vendorId?: number;
  tags?: string[];
  reasons: string[];
  aliases?: string[];
}

export interface ExclusionEntry {
  modelName: string;
  reason: string;
}
export interface DiscoveryReport {
  candidates: Candidate[];
  excluded: ExclusionEntry[];
}

// prettier-ignore
const NAME_ALLOWLIST_PATTERNS = ["gpt-image","qwen-image-edit","qwen/qwen-image-edit","qwen-image-max-edit","seedream","seededit","nano-banana","flux-edit","flux-kontext","img2img","image-to-image","mj_edits","mj_blend","mj_variation","kling-image","kling-omni","wan2","wan-","chatgpt-image","doubao-seedream","recraft","ideogram","stable-diffusion","sd-3","sd3","hunyuan-image","hunyuanimage","mai-image","runway","runwayml","luma","ray-2","photon","image-01","minimax-image","krea","firefly","bagel","fal-ai/","qwen-image","flux-pro","flux-1.1","flux-2","flux-dev","flux-schnell","imagen","gpt-4o-image","z-image-turbo","z-image","jimeng-image","ernie-irag","ernie-image","wanx"] as const;

// prettier-ignore
const NAME_COMPOUND_PATTERNS: ReadonlyArray<readonly [string, string]> = [["gemini","image"],["chatgpt","image"],["openai/","image"],["google/","image"],["grok-","image"],["gpt-4o","image"]];

// prettier-ignore
const NAME_EXCLUSION_PATTERNS = ["dall-e","imagen-fast","kling-effects","kling-video-extend","sora","-feed","-uploads","-upload","-proxy","voices-list","describe","recognize","moderation","tts","-stt","whisper","-voice-","video-to-audio","voice-design","voice-clone","-t2v","t2v-","-i2v","i2v-","-r2v","r2v-","-s2v","s2v-","-kf2v","kf2v-","text-to-video","image-to-video","reference-to-video","video-extend","-animate","animate-","video2video","veo","luma-ray","ray-2","luma-video","luma-dream-machine","runway-","runway_","runwayml-","runwayml_","kling-video","doubao-seedance","seedance","hailuo","mingmou","happyhorse","-video-","openai-video","kling-avatar","vidu","luma","vace","upscale","inpaint","outpaint","vectorize","create-style"] as const;

const ENDPOINT_HINTS = new Set([
  "image-generation",
  "image-edit",
  "aigc-image",
  "aigc-image-edit",
  "openai-image",
]);
const ENDPOINT_EXCLUSIONS = new Set(["openai-video", "omni-video"]);

interface DiscoverOpts {
  providerName: string;
  pricing: UpstreamPricing;
  legacyModelInfo?: Record<
    string,
    { supplier?: string; tags?: string[]; illustrate?: string }
  >;
  modelNameFilter?: string[];
}

const IMAGE_OUTPUT_TAG_RE =
  /(?:绘画|生图|扩图|修图|画图|出图|文生图|图生图|dall-?e|paint(?:ing)?|draw(?:ing)?|image[- ]?gen|image[- ]?edit|text[- ]?to[- ]?image)/i;
const VISION_INPUT_TAG_RE =
  /(?:图像分析|图片分析|图像识别|图片识别|图像理解|图片理解|视觉|多模态|vision|multimodal)/i;

const STUB_FIXTURES: Fixtures = {
  prompt: "test",
  files: [],
  dataUris: ["data:image/jpeg;base64,AAAA"],
  totalBytes: 0,
};
const DEFAULT_OAI_PATHS = new Set(SHARED_OAI_PATHS);

// prettier-ignore
const KIND_BY_NAME_PATTERN: ReadonlyArray<readonly [string, ProbeKind]> = [
  ...["gpt-image","chatgpt-image","imagen","recraft","ideogram","stable-diffusion","sd-3","sd3","mai-image","firefly","krea","flux-1.1","flux-2","flux-pro","flux-schnell","flux-dev"].map((p) => [p, "sync"] as const),
  ...["runway","runwayml","ray-2","luma_video","luma-video","photon"].map((p) => [p, "task"] as const),
];

function pickKind(
  endpointTypes: string[],
  lowerName: string,
): ProbeKind | undefined {
  if (endpointTypes.includes("openai-video")) return "task";
  if (endpointTypes.includes("image-generation")) return "sync";
  if (endpointTypes.includes("openai-image")) return "sync";
  if (
    endpointTypes.length === 0 ||
    endpointTypes.every((e) => e === "openai")
  ) {
    for (const [pattern, kind] of KIND_BY_NAME_PATTERN)
      if (lowerName.includes(pattern)) return kind;
    return "openai-vendor";
  }
  return undefined;
}

function matchFilter(lower: string, filters: string[]): boolean {
  for (const f of filters) {
    const lf = f.toLowerCase();
    if (lf.includes("*")) {
      const re = new RegExp(
        "^" +
          lf.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
          "$",
      );
      if (re.test(lower)) return true;
    } else if (lower.includes(lf)) return true;
  }
  return false;
}

export function discoverCandidates(opts: DiscoverOpts): DiscoveryReport {
  const candidates: Candidate[] = [];
  const excluded: ExclusionEntry[] = [];
  const filters = opts.modelNameFilter;

  for (const m of opts.pricing.models) {
    const lower = m.name.toLowerCase();
    if (filters?.length && !matchFilter(lower, filters)) continue;

    const exclusion = NAME_EXCLUSION_PATTERNS.find((p) => lower.includes(p));
    if (exclusion) {
      excluded.push({
        modelName: m.name,
        reason: `exclusion-list:${exclusion}`,
      });
      continue;
    }

    const eps = m.supportedEndpoints ?? [];
    const epExclusion = eps.find((e) => ENDPOINT_EXCLUSIONS.has(e));
    const hasUsableEdit = eps.some((e) => ENDPOINT_HINTS.has(e));
    if (epExclusion && !hasUsableEdit) {
      excluded.push({
        modelName: m.name,
        reason: `endpoint-exclusion:${epExclusion}`,
      });
      continue;
    }

    const reasons: string[] = [];
    const epHits = eps.filter((e) => ENDPOINT_HINTS.has(e));
    if (epHits.length > 0) reasons.push(`endpoint:${epHits.join(",")}`);
    const nameHit = NAME_ALLOWLIST_PATTERNS.find((p) => lower.includes(p));
    if (nameHit) reasons.push(`name:${nameHit}`);
    const compoundHit = NAME_COMPOUND_PATTERNS.find(
      ([a, b]) => lower.includes(a) && lower.includes(b),
    );
    if (compoundHit) reasons.push(`name:${compoundHit[0]}+${compoundHit[1]}`);

    const tags = opts.legacyModelInfo?.[m.name]?.tags;
    if (tags) {
      const outputTagHit = tags.find((t) => IMAGE_OUTPUT_TAG_RE.test(t));
      const visionOnlyHit = tags.find((t) => VISION_INPUT_TAG_RE.test(t));
      if (outputTagHit) reasons.push(`tag:${outputTagHit}`);
      else if (visionOnlyHit && reasons.length === 0 && !hasUsableEdit) {
        excluded.push({
          modelName: m.name,
          reason: `vision-input-only (tag:${visionOnlyHit})`,
        });
        continue;
      }
    }
    if (reasons.length === 0) continue;

    let kind = pickKind(eps, lower);
    if (!kind && (nameHit || compoundHit)) kind = pickKind([], lower);
    if (!kind) {
      excluded.push({
        modelName: m.name,
        reason: `kind-undetermined (endpoints=${eps.join(",") || "none"})`,
      });
      continue;
    }
    candidates.push({
      providerName: opts.providerName,
      modelName: m.name,
      canonicalKey: canonicalize(m.name),
      kind,
      endpointTypes: eps,
      vendorId: m.vendorId,
      tags,
      reasons,
    });
  }

  const grouped = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = grouped.get(c.canonicalKey);
    if (arr) arr.push(c);
    else grouped.set(c.canonicalKey, [c]);
  }
  const dedupedRaw: Candidate[] = [];
  for (const [, group] of grouped) {
    const winner = pickRepresentative(group);
    const aliases = group
      .filter((c) => c.modelName !== winner.modelName)
      .map((c) => c.modelName);
    dedupedRaw.push({
      ...winner,
      aliases: aliases.length > 0 ? aliases : undefined,
    });
  }

  const deduped: Candidate[] = [];
  for (const c of dedupedRaw) {
    let handled = c.endpointTypes.length === 0;
    for (const ep of c.endpointTypes) {
      const r = resolveEndpoint({
        endpointType: ep,
        modelName: c.modelName,
        pricing: opts.pricing,
      });
      if (!r) continue;
      if (
        DEFAULT_OAI_PATHS.has(r.path) ||
        buildBody({
          path: r.path,
          model: c.modelName,
          fixtures: STUB_FIXTURES,
        }) !== null
      ) {
        handled = true;
        break;
      }
    }
    if (!handled) {
      excluded.push({
        modelName: c.modelName,
        reason: `unhandled-body (endpoints=${c.endpointTypes.join(",") || "none"})`,
      });
      continue;
    }
    deduped.push(c);
  }
  return { candidates: deduped, excluded };
}
