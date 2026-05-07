import type { UpstreamPricing } from "@core/vendors/newapi/types";

/**
 * Three-flavor probe routing. Determined by the model's exposed endpoint
 * types (when present), falling back to name heuristics for legacy
 * `model_info` shape (yun) where `supported_endpoint_types` is missing.
 */
export type ProbeKind = "sync" | "openai-vendor" | "task";

export interface Candidate {
  providerName: string;
  modelName: string;
  kind: ProbeKind;
  endpointTypes: string[];
  vendorId?: number;
  /** Tags surfaced for the dry-run report (e.g. ["绘画", "dall-e-3格式"]). */
  tags?: string[];
  /** Human-readable reasons the model qualified, for the dry-run report. */
  reasons: string[];
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
] as const;

/**
 * Names that look image-y but cannot accept refs (text-to-image only) or
 * cannot accept 6 refs in any submit shape. Skipped at discovery time so
 * we don't bill a billable failure.
 */
const NAME_EXCLUSION_PATTERNS = [
  "dall-e",
  "imagen-fast",
  "kling-effects",
  "kling-video-extend",
  "sora",
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
    //    pricing shape doesn't expose endpoints (V2 / yun).
    const kind = pickKind(eps, lower);
    if (!kind) {
      // Endpoints exist but only contain non-image types, and name doesn't
      // disambiguate. Skip silently — likely a chat model that happens to
      // have a vision tag.
      excluded.push({
        modelName: m.name,
        reason: `kind-undetermined (endpoints=${eps.join(",") || "none"})`,
      });
      continue;
    }

    candidates.push({
      providerName: opts.providerName,
      modelName: m.name,
      kind,
      endpointTypes: eps,
      vendorId: m.vendorId,
      tags,
      reasons,
    });
  }

  return { candidates, excluded };
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
    // No endpoint metadata — infer from name. gpt-image / chatgpt-image /
    // imagen go through OpenAI's image-edit endpoint. Everything else with
    // a name hit defaults to "openai-vendor" (chat-completions multimodal).
    if (
      lowerName.includes("gpt-image") ||
      lowerName.includes("chatgpt-image") ||
      lowerName.includes("imagen")
    ) {
      return "sync";
    }
    return "openai-vendor";
  }

  // Has endpoints but none of the recognized image kinds. Caller will mark
  // as kind-undetermined and exclude.
  return undefined;
}
