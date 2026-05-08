import type { UpstreamPricing } from "@core/vendors/newapi/types";
import { canonicalize, pickRepresentative } from "./canonicalize";

/**
 * Three-flavor probe routing. Determined by the model's exposed endpoint
 * types (when present), falling back to name heuristics for legacy
 * `model_info` shape (yun) where `supported_endpoint_types` is missing.
 */
export type ProbeKind = "sync" | "openai-vendor" | "task";

export interface Candidate {
  providerName: string;
  modelName: string;
  /**
   * Canonicalized form of `modelName` used for cross-slug dedup within a
   * provider. Different gateway aliases of the same upstream (e.g.
   * `recraft-v3`, `recraftv3`, `recraft-ai/recraft-v3`) share a key.
   */
  canonicalKey: string;
  kind: ProbeKind;
  endpointTypes: string[];
  vendorId?: number;
  /** Tags surfaced for the dry-run report (e.g. ["绘画", "dall-e-3格式"]). */
  tags?: string[];
  /** Human-readable reasons the model qualified, for the dry-run report. */
  reasons: string[];
  /**
   * Other modelName slugs that mapped to the same canonical key on this
   * provider. We probe one representative; the rest are listed for the
   * dry-run report. Empty when no aliases exist.
   */
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

// ---------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------

/**
 * Candidate name patterns. A match here AND any of the discovery signals
 * promotes a model into the probe set. Stored as substrings so glob libs
 * aren't a runtime dependency just for this. Patterns are matched against
 * `modelName.toLowerCase()`.
 */
const NAME_ALLOWLIST_PATTERNS = [
  // Existing 15 vendor families
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
  "kling-image",   // kling-image-* are image models; kling-v* / kling-video* are video (excluded)
  "kling-omni",    // kling-v3-omni is multimodal image-edit (matches via canonicalize too)
  "wan2",
  "wan-",
  "chatgpt-image",
  "doubao-seedream",
  // Added: vendors discovered via getcheapai cross-check
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
  // Added: missed-image audit (reference/analysis/missing-image-models.txt)
  "qwen-image",        // qwen-image-2.0, qwen-image-plus, qwen-image-max (no -edit suffix)
  "flux-pro",          // covers flux-pro, flux-pro-1.1, flux-pro-max (vendor-prefix forms via canonicalize)
  "flux-1.1",
  "flux-2",
  "flux-dev",
  "flux-schnell",
  "imagen",            // imagen-3.0-generate-002, imagen-4.0-ultra-generate-001 (Google text-to-image)
  // Added: final triple-check audit (silent rejects with image-y signals)
  // Grok image variants caught via the "grok" + "image" compound below.
  "gpt-4o-image",      // OpenAI GPT-4o image variant (separate SKU from gpt-image-*)
  "z-image-turbo",     // Alibaba Z-Image Turbo
  "z-image",           // future Z-Image variants
  "jimeng-image",      // ByteDance Jimeng image (separate from jimeng-4.x video)
  "ernie-irag",        // Baidu Ernie image: ernie-irag-edit, ernie-irag
  "ernie-image",       // Baidu Ernie image variants
  "wanx",              // Alibaba Wan-X family: wanx2.0-t2i-turbo
] as const;

/**
 * Compound patterns: a model is a candidate if its name contains BOTH tokens
 * (in any order). Used for cases where a single substring is too aggressive
 * (e.g. matching "gemini" alone would catch every Gemini chat model, but
 * "gemini" + "image" only catches the image-generation Geminis).
 */
const NAME_COMPOUND_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ["gemini", "image"],          // gemini-2.5-flash-image, gemini-3-pro-image-preview
  ["chatgpt", "image"],          // already covered by single pattern, kept for symmetry
  ["openai/", "image"],          // openai/gpt-5-image, openai/gpt-5.4-image-2 (openrouter-style)
  ["google/", "image"],          // google/gemini-3-pro-image-preview
  ["grok-", "image"],            // grok-2-image, grok-3-image, grok-4.1-image, grok-imagine-image*
  ["gpt-4o", "image"],           // gpt-4o-image, gpt-4o-image-vip (NOT same as gpt-image-*)
];

/**
 * Names that look image-y but cannot accept refs (text-to-image only),
 * are not generation endpoints at all (file/feed/proxy bookkeeping),
 * are vision/OCR (image-in -> text-out, opposite direction), or are
 * speech/audio. Skipped at discovery time so we don't bill failures or
 * waste probes on non-models.
 */
const NAME_EXCLUSION_PATTERNS = [
  // Text-to-image only / can't accept 6 refs
  "dall-e",
  "imagen-fast",
  "kling-effects",
  "kling-video-extend",
  "sora",
  // Bookkeeping / non-model endpoints exposed in pricing
  "-feed",          // runway-v1-feed, kling-image-expend-feed (queue endpoints)
  "-uploads",       // runway-v1-uploads, runway-uploads (file upload helpers)
  "-upload",
  "-proxy",         // runway-v1-proxy, luma-proxy (channel proxy meta)
  "voices-list",    // kling-voices-list
  // Vision (image-in -> text-out), opposite of what the probe tests
  "describe",       // ideogram-describe, ideogram_describe
  "recognize",      // kling-image-recognize, ideogram_recognize
  "moderation",
  // Audio / speech (different modality entirely)
  "tts",            // vidu-tts, *-tts
  "-stt",
  "whisper",
  "-voice-",
  "video-to-audio", // kling-video-to-audio (video -> audio)
  "voice-design",
  "voice-clone",
  // Video models: any model that produces video output. The probe targets
  // image-edit (still output) only - video gen accepts 1-2 refs at most
  // for image-to-video, can't compose 6 character refs into a scene, and
  // burns disproportionate budget per call. Match aggressively to catch
  // every video naming convention seen in the catalogs.
  "-t2v",          // text-to-video: wan2.5-t2v-preview
  "t2v-",          // wan2.2-t2v-plus, t2v-models
  "-i2v",          // image-to-video: wan2.6-i2v, wan2.2-i2v-flash
  "i2v-",
  "-r2v",          // reference-to-video: wan2.6-r2v, vidu r2v
  "r2v-",
  "-s2v",          // scene-to-video / speech-to-video
  "s2v-",
  "-kf2v",         // keyframe-to-video: wan2.2-kf2v-flash
  "kf2v-",
  "text-to-video",
  "image-to-video",
  "reference-to-video",
  "video-extend",  // kling-video-extend (already in legacy list, kept)
  "-animate",      // wan2.2-animate-mix, wan2.2-animate-move
  "animate-",
  "video2video",   // runway-video2video, runway_duomi-video2video
  "veo",           // veo2/veo3/veo3.1 - all text/image-to-video
  "luma-ray",      // luma-ray-2, luma-ray-2-flash - video models
  "ray-2",
  "luma-video",
  "luma-dream-machine",
  "runway-",       // runway-aleph, runway-act-one, runway-act-two, runway-gen3/4
  "runway_",       // runway_duomi, runway_video2video (underscore form)
  "runwayml-",     // runwayml-gen3a, runwayml-gen4
  "runwayml_",
  "kling-video",   // kling-video-pro, kling-video-std, kling-video-o1
  "doubao-seedance", // ByteDance Seedance is video
  "seedance",
  "hailuo",        // MiniMax Hailuo video
  "mingmou",       // Mingmou-1.0 (666 video)
  "happyhorse",    // happyhorse-1.0-t2v/i2v/r2v
  "-video-",       // any -video- in the middle is a video model variant
  "openai-video",  // generic
  "kling-avatar",  // kling-avatar-image2video
  "vidu",          // all Vidu models are video (vidu1.5, viduq1, viduq2-turbo, etc.)
  "luma",          // all Luma models are video (luma_video, luma-vip-video, ray-2*)
  "vace",          // Alibaba VACE: video all-in-one creation engine (wanx2.1-vace-plus)
  // Single-input image-to-image utilities (upscale / inpaint / outpaint /
  // vectorize). These accept exactly 1 image + (optional mask) so the
  // probe-sync 6-ref multipart will fail. We still want them in the
  // probe-openai-vendor flow potentially, but most are upstream-managed
  // utility ops not generation. Excluding for now.
  "upscale",
  "inpaint",
  "outpaint",
  "vectorize",
  "create-style",
] as const;

/**
 * Endpoint type values that signal an image-edit or image-output capability.
 * Sourced from the live `supported_endpoint_types` arrays of aigc and yun
 * pricing responses.
 *
 * NOTE: `openai-video` is intentionally NOT here. We probe still-image
 * surfaces only - video models accept 1-2 refs at most, can't compose 6
 * character images into a scene, and burn disproportionate budget per
 * call. Models routed via `openai-video` are excluded entirely below.
 */
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
  "openai-video",  // standard new-api video task surface
  "omni-video",    // yun-style alternate video endpoint
]);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface DiscoverOpts {
  providerName: string;
  pricing: UpstreamPricing;
  /**
   * Raw V2 `model_info` block (yun-style) when present. Used to surface
   * tags/supplier that `parsePricing` doesn't carry on `ModelInfo`. Optional;
   * absent for the V1 shape (aigc) where everything we need is already on
   * `pricing.models[*]`.
   */
  legacyModelInfo?: Record<
    string,
    { supplier?: string; tags?: string[]; illustrate?: string }
  >;
  /** Glob-like name filter from --models. Empty array = no filter. */
  modelNameFilter?: string[];
}

export function discoverCandidates(opts: DiscoverOpts): DiscoveryReport {
  const candidates: Candidate[] = [];
  const excluded: ExclusionEntry[] = [];

  for (const m of opts.pricing.models) {
    const lower = m.name.toLowerCase();

    // 1. --models glob filter (optional, applied first so excluded entries
    //    don't pollute the dry-run report when the user is narrowing scope).
    if (opts.modelNameFilter && opts.modelNameFilter.length > 0) {
      if (!matchesAnyFilter(lower, opts.modelNameFilter)) continue;
    }

    // 2. Hard exclusions (text-to-image only, effects, etc.).
    const exclusion = NAME_EXCLUSION_PATTERNS.find((p) => lower.includes(p));
    if (exclusion) {
      excluded.push({
        modelName: m.name,
        reason: `exclusion-list:${exclusion}`,
      });
      continue;
    }

    // 2b. Endpoint-based exclusion. A model self-tagging with a video or
    //     dall-e-3-only endpoint shape is excluded - video models accept
    //     1-2 refs at most (not 6), and dall-e-3 wire format is text-to-
    //     image-only. EXCEPTION: if the model ALSO advertises a real
    //     image-edit endpoint (image-generation, image-edit, openai-image),
    //     keep it - those endpoints take precedence and we'll route there.
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

    // 3. Collect signals.
    const reasons: string[] = [];
    const epHits = eps.filter((e) => ENDPOINT_HINTS.has(e));
    if (epHits.length > 0) reasons.push(`endpoint:${epHits.join(",")}`);

    const nameHit = NAME_ALLOWLIST_PATTERNS.find((p) => lower.includes(p));
    if (nameHit) reasons.push(`name:${nameHit}`);

    // Compound name patterns. A model qualifies when both substrings appear
    // anywhere in the name (e.g. `gemini` + `image` catches the image-output
    // Geminis without false-positive-ing every Gemini chat variant).
    const compoundHit = NAME_COMPOUND_PATTERNS.find(
      ([a, b]) => lower.includes(a) && lower.includes(b),
    );
    if (compoundHit) reasons.push(`name:${compoundHit[0]}+${compoundHit[1]}`);

    const legacy = opts.legacyModelInfo?.[m.name];
    const tags = legacy?.tags;
    if (tags) {
      // Painting / draw / image edit Chinese tags.
      const tagHit = tags.find((t) =>
        /(?:绘画|图像|图片|生图|扩图|修图|edit|paint|image)/i.test(t),
      );
      if (tagHit) reasons.push(`tag:${tagHit}`);
    }

    if (reasons.length === 0) continue;

    // 4. Pick a kind based on endpoint type, falling back to name when the
    //    pricing shape doesn't expose endpoints (V2 / yun) OR exposes
    //    non-standard endpoint values (some gateways use "chat" / "images"
    //    / "Generate image" instead of new-api's standard
    //    "image-generation" / "openai-video"). When the name signal fired
    //    but endpoint kind is undetermined, infer from the name pattern
    //    rather than dropping a likely-image candidate on the floor.
    let kind = pickKind(eps, lower);
    if (!kind && (nameHit || compoundHit)) {
      kind = pickKind([], lower);
    }
    if (!kind) {
      // No name hit AND endpoints don't disambiguate. Skip silently —
      // likely a chat model that happens to have a vision tag.
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

  // Per-provider dedup: collapse slug variants of the same upstream into
  // one Candidate per canonical key. The "winning" entry is the shortest
  // modelName (heuristic that filters out date-stamped / -all / -vip
  // variants when the bare name is also present); the rest become aliases
  // listed in the dry-run report.
  const grouped = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = grouped.get(c.canonicalKey);
    if (arr) arr.push(c);
    else grouped.set(c.canonicalKey, [c]);
  }
  const deduped: Candidate[] = [];
  for (const [, group] of grouped) {
    const winner = pickRepresentative(group);
    const aliases = group
      .filter((c) => c.modelName !== winner.modelName)
      .map((c) => c.modelName);
    deduped.push({
      ...winner,
      aliases: aliases.length > 0 ? aliases : undefined,
    });
  }

  return { candidates: deduped, excluded };
}

/**
 * Match a model name (lowercase) against any of the user-supplied --models
 * patterns. Patterns are simple substring matches OR globs containing `*`.
 */
function matchesAnyFilter(lowerName: string, filters: string[]): boolean {
  for (const f of filters) {
    const lower = f.toLowerCase();
    if (lower.includes("*")) {
      // Convert glob to regex. * → .*, escape other regex meta chars.
      const re = new RegExp(
        "^" +
          lower
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*") +
          "$",
      );
      if (re.test(lowerName)) return true;
    } else if (lowerName.includes(lower)) {
      return true;
    }
  }
  return false;
}

/**
 * Decide which probe path the candidate goes through:
 * - "task" if endpoints include `openai-video`.
 * - "sync" if endpoints include `image-generation` (or no endpoints exposed
 *   AND name suggests image-edit: gpt-image*, chatgpt-image*, imagen*).
 * - "openai-vendor" if endpoints include only `openai` (chat-completions
 *   shaped, vendor-specific body translation by new-api).
 */
function pickKind(endpointTypes: string[], lowerName: string): ProbeKind | undefined {
  if (endpointTypes.includes("openai-video")) return "task";
  if (endpointTypes.includes("image-generation")) return "sync";
  if (endpointTypes.includes("openai-image")) return "sync";

  if (endpointTypes.length === 0 || endpointTypes.every((e) => e === "openai")) {
    // No endpoint metadata — infer from name.
    // Sync path (true /v1/images/edits surface): vendors that ship the
    // OpenAI-image-edit shape directly via new-api translation.
    if (
      lowerName.includes("gpt-image") ||
      lowerName.includes("chatgpt-image") ||
      lowerName.includes("imagen") ||
      lowerName.includes("recraft") ||
      lowerName.includes("ideogram") ||
      lowerName.includes("stable-diffusion") ||
      lowerName.includes("sd-3") ||
      lowerName.includes("sd3") ||
      lowerName.includes("mai-image") ||
      lowerName.includes("firefly") ||
      lowerName.includes("krea") ||
      lowerName.includes("flux-1.1") ||
      lowerName.includes("flux-2") ||
      lowerName.includes("flux-pro") ||
      lowerName.includes("flux-schnell") ||
      lowerName.includes("flux-dev")
    ) {
      return "sync";
    }
    // Task path (submit + poll): video models that go through /v1/videos.
    if (
      lowerName.includes("runway") ||
      lowerName.includes("runwayml") ||
      lowerName.includes("ray-2") ||
      lowerName.includes("luma_video") ||
      lowerName.includes("luma-video") ||
      lowerName.includes("photon")
    ) {
      return "task";
    }
    return "openai-vendor";
  }

  // Has endpoints but none of the recognized image kinds. Caller will mark
  // as kind-undetermined and exclude.
  return undefined;
}
