import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { buildBody } from "./body-builder";
import { canonicalize, pickRepresentative } from "./canonicalize";
import { resolveEndpoint, SHARED_OAI_PATHS } from "./endpoint-resolver";
import type { Fixtures } from "./fixtures";

/** Routed by exposed endpoint types when present; falls back to name heuristics for legacy (yun) pricing without `supported_endpoint_types`. */
export type ProbeKind = "sync" | "openai-vendor" | "task";

export interface Candidate {
  providerName: string;
  modelName: string;
  /** Slug-collapse dedup key (recraft-v3, recraftv3, recraft-ai/recraft-v3 share it). */
  canonicalKey: string;
  kind: ProbeKind;
  endpointTypes: string[];
  vendorId?: number;
  tags?: string[];
  reasons: string[];
  /** Other slugs that mapped to the same canonicalKey on this provider. */
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

// ─── Routing rules ────────────────────────────────────────────────────────
// See reference/analysis/missing-image-models.txt for the audit trail.
// Substring-matched against modelName.toLowerCase(). Compound = both tokens
// must be present (avoids "gemini" sweeping every Gemini chat model).

const NAME_ALLOWLIST_PATTERNS = [
  "gpt-image",
  "qwen-image-edit",
  "qwen/qwen-image-edit",
  "qwen-image-max-edit",
  "seedream",
  "seededit",
  "nano-banana",
  "flux-edit",
  "flux-kontext",
  "img2img",
  "image-to-image",
  "mj_edits",
  "mj_blend",
  "mj_variation",
  "kling-image",
  "kling-omni",
  "wan2",
  "wan-",
  "chatgpt-image",
  "doubao-seedream",
  "recraft",
  "ideogram",
  "stable-diffusion",
  "sd-3",
  "sd3",
  "hunyuan-image",
  "hunyuanimage",
  "mai-image",
  "runway",
  "runwayml",
  "luma",
  "ray-2",
  "photon",
  "image-01",
  "minimax-image",
  "krea",
  "firefly",
  "bagel",
  "fal-ai/",
  "qwen-image",
  "flux-pro",
  "flux-1.1",
  "flux-2",
  "flux-dev",
  "flux-schnell",
  "imagen",
  "gpt-4o-image",
  "z-image-turbo",
  "z-image",
  "jimeng-image",
  "ernie-irag",
  "ernie-image",
  "wanx",
] as const;

const NAME_COMPOUND_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ["gemini", "image"],
  ["chatgpt", "image"],
  ["openai/", "image"],
  ["google/", "image"],
  ["grok-", "image"],
  ["gpt-4o", "image"],
];

/** Looks image-y but isn't: t2i-only, file/proxy bookkeeping, vision (image-in -> text-out), audio, video output, single-input utilities (upscale/inpaint/etc). */
const NAME_EXCLUSION_PATTERNS = [
  "dall-e",
  "imagen-fast",
  "kling-effects",
  "kling-video-extend",
  "sora",
  "-feed",
  "-uploads",
  "-upload",
  "-proxy",
  "voices-list",
  "describe",
  "recognize",
  "moderation",
  "tts",
  "-stt",
  "whisper",
  "-voice-",
  "video-to-audio",
  "voice-design",
  "voice-clone",
  "-t2v",
  "t2v-",
  "-i2v",
  "i2v-",
  "-r2v",
  "r2v-",
  "-s2v",
  "s2v-",
  "-kf2v",
  "kf2v-",
  "text-to-video",
  "image-to-video",
  "reference-to-video",
  "video-extend",
  "-animate",
  "animate-",
  "video2video",
  "veo",
  "luma-ray",
  "ray-2",
  "luma-video",
  "luma-dream-machine",
  "runway-",
  "runway_",
  "runwayml-",
  "runwayml_",
  "kling-video",
  "doubao-seedance",
  "seedance",
  "hailuo",
  "mingmou",
  "happyhorse",
  "-video-",
  "openai-video",
  "kling-avatar",
  "vidu",
  "luma",
  "vace",
  "upscale",
  "inpaint",
  "outpaint",
  "vectorize",
  "create-style",
] as const;

/** `openai-video` deliberately excluded: probe targets still-image only. */
const ENDPOINT_HINTS = new Set([
  "image-generation",
  "image-edit",
  "aigc-image",
  "aigc-image-edit",
  "openai-image",
]);

/**
 * Endpoint values that ALWAYS exclude a model regardless of name match.
 * Anything self-tagging as a video endpoint is a video model.
 *
 * NOT excluded: `dall-e-3`. Even though that wire format is text-to-image
 * only (with optional 1 mask image), we still probe it with all 6 refs
 * and let the upstream reject. The negative ground truth ("this gateway's
 * gpt-image-2-all reverse-eng variant rejects 6-ref multipart") is more
 * valuable than skipping silently - some reverse-eng SKUs are the cheapest
 * access path to a vendor and you may want to know exactly how they fail.
 */
const ENDPOINT_EXCLUSIONS = new Set([
  "openai-video", // standard new-api video task surface
  "omni-video", // yun-style alternate video endpoint
]);

// ─── Discovery ────────────────────────────────────────────────────────────

interface DiscoverOpts {
  providerName: string;
  pricing: UpstreamPricing;
  /** Raw V2 model_info (yun) surfaces tags `parsePricing` strips. */
  legacyModelInfo?: Record<
    string,
    { supplier?: string; tags?: string[]; illustrate?: string }
  >;
  /** --models glob filter; empty = no filter. */
  modelNameFilter?: string[];
}

// Image-OUTPUT signals. `图像`/`图片` alone are deliberately excluded — they leak
// vision-only chat models (gpt-4-all has 图像分析 = "image analysis") which 200
// with text-only refusals that still bill tokens.
const IMAGE_OUTPUT_TAG_RE =
  /(?:绘画|生图|扩图|修图|画图|出图|文生图|图生图|dall-?e|paint(?:ing)?|draw(?:ing)?|image[- ]?gen|image[- ]?edit|text[- ]?to[- ]?image)/i;
const VISION_INPUT_TAG_RE =
  /(?:图像分析|图片分析|图像识别|图片识别|图像理解|图片理解|视觉|多模态|vision|multimodal)/i;

export function discoverCandidates(opts: DiscoverOpts): DiscoveryReport {
  const candidates: Candidate[] = [];
  const excluded: ExclusionEntry[] = [];

  for (const m of opts.pricing.models) {
    const lower = m.name.toLowerCase();

    if (
      opts.modelNameFilter?.length &&
      !matchesAnyFilter(lower, opts.modelNameFilter)
    ) {
      continue;
    }

    const exclusion = NAME_EXCLUSION_PATTERNS.find((p) => lower.includes(p));
    if (exclusion) {
      excluded.push({
        modelName: m.name,
        reason: `exclusion-list:${exclusion}`,
      });
      continue;
    }

    // Endpoint exclusion: video/dall-e-3 shapes — unless the model ALSO advertises
    // a real image-edit endpoint, in which case we'll route there instead.
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
      if (outputTagHit) {
        reasons.push(`tag:${outputTagHit}`);
      } else if (
        visionOnlyHit &&
        reasons.length === 0 &&
        !eps.some((e) => ENDPOINT_HINTS.has(e))
      ) {
        excluded.push({
          modelName: m.name,
          reason: `vision-input-only (tag:${visionOnlyHit})`,
        });
        continue;
      }
    }

    if (reasons.length === 0) continue;

    // Endpoint-based kind first; fall back to name when endpoints are missing
    // (V2) or non-standard (some gateways use "chat" / "Generate image").
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

  // Slug-variant dedup: pick the shortest name (filters date stamps / -all /
  // -vip when the bare name is also present); the rest become aliases.
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

  // Drop candidates whose every endpoint resolves to a body we can't construct
  // (e.g. kling's /kling/v1/images/* uses vendor-native schemas we don't speak).
  // ANY handled endpoint is enough; unhandled ones fail-fast without billing.
  const deduped: Candidate[] = [];
  for (const c of dedupedRaw) {
    if (!hasAtLeastOneHandledEndpoint(c, opts.pricing)) {
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

/** Stub used only to ask buildBody() whether a path has a registered builder; bytes are never sent. */
const STUB_FIXTURES: Fixtures = {
  prompt: "test",
  files: [],
  dataUris: ["data:image/jpeg;base64,AAAA"],
  totalBytes: 0,
};

const DEFAULT_OAI_PATHS = new Set(SHARED_OAI_PATHS);

/** True if ANY endpoint resolves to a path we can construct a body for. Drops models that only advertise vendor-native paths we don't speak. */
function hasAtLeastOneHandledEndpoint(
  c: Candidate,
  pricing: UpstreamPricing,
): boolean {
  for (const ep of c.endpointTypes) {
    const r = resolveEndpoint({
      endpointType: ep,
      modelName: c.modelName,
      pricing,
    });
    if (!r) continue;
    if (DEFAULT_OAI_PATHS.has(r.path)) return true;
    if (
      buildBody({
        path: r.path,
        model: c.modelName,
        fixtures: STUB_FIXTURES,
      }) !== null
    ) {
      return true;
    }
  }
  return c.endpointTypes.length === 0; // empty → default-OAI fallback
}

/** Substring or `*`-glob match against lowercase name. */
function matchesAnyFilter(lowerName: string, filters: string[]): boolean {
  for (const f of filters) {
    const lower = f.toLowerCase();
    if (lower.includes("*")) {
      const re = new RegExp(
        "^" +
          lower.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
          "$",
      );
      if (re.test(lowerName)) return true;
    } else if (lowerName.includes(lower)) return true;
  }
  return false;
}

/** Name-pattern fallback when endpoints are empty/`openai`-only. Adding a vendor: also add to NAME_ALLOWLIST_PATTERNS. */
const KIND_BY_NAME_PATTERN: ReadonlyArray<readonly [string, ProbeKind]> = [
  // Sync (/v1/images/edits direct).
  ["gpt-image", "sync"],
  ["chatgpt-image", "sync"],
  ["imagen", "sync"],
  ["recraft", "sync"],
  ["ideogram", "sync"],
  ["stable-diffusion", "sync"],
  ["sd-3", "sync"],
  ["sd3", "sync"],
  ["mai-image", "sync"],
  ["firefly", "sync"],
  ["krea", "sync"],
  ["flux-1.1", "sync"],
  ["flux-2", "sync"],
  ["flux-pro", "sync"],
  ["flux-schnell", "sync"],
  ["flux-dev", "sync"],
  // Task (submit + poll) — for video models that escape the exclusion list.
  ["runway", "task"],
  ["runwayml", "task"],
  ["ray-2", "task"],
  ["luma_video", "task"],
  ["luma-video", "task"],
  ["photon", "task"],
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
    for (const [pattern, kind] of KIND_BY_NAME_PATTERN) {
      if (lowerName.includes(pattern)) return kind;
    }
    return "openai-vendor";
  }
  return undefined;
}
