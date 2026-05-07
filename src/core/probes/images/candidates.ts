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
  "kling-v",
  "kling-image",
  "wan2",
  "wan-",
  "vidu",
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
  // Single-input image-to-image utilities (upscale / inpaint / outpaint /
  // extend / nomark). These accept exactly 1 image + (optional mask), so a
  // 6-ref probe will fail with "expected 1, got 6" 100% of the time.
  // Leaving them in just burns budget on guaranteed failures.
  "upscale",
  "inpaint",
  "outpaint",
  "_extend",       // luma_extend (yun-style underscore form)
  "-extend",
  "_nomark",       // luma_nomark
  "-nomark",
  "vectorize",     // recraft-vectorize: PNG -> SVG, single input only
  "create-style",  // recraft-create-style: builds a style ref, not gen
] as const;

/**
 * Endpoint type values that signal an image-edit or image-output capability.
 * Sourced from the live `supported_endpoint_types` arrays of aigc and yun
 * pricing responses.
 */
const ENDPOINT_HINTS = new Set([
  "image-generation",
  "image-edit",
  "aigc-image",
  "aigc-image-edit",
  "openai-image",
  "openai-video",
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

    // 3. Collect signals.
    const reasons: string[] = [];
    const eps = m.supportedEndpoints ?? [];
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
