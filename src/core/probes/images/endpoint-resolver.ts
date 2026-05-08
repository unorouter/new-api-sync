import type { UpstreamPricing } from "@core/vendors/newapi/types";
import type { ProbeShape } from "./store";

/**
 * Resolve the actual upstream URL + wire shape for a (model, endpoint-type)
 * pair. The general solution: every new-api provider declares its own
 * `supported_endpoint` map (`endpointPaths` after parsing) listing what
 * URL serves what endpoint type. Yun's V2 schema declares 156+ entries
 * including `xxx异步 -> /replicate/v1/models/{model}/predictions`,
 * link declares `Edit image -> /v1/images/edits`, v3 declares nothing
 * (we fall back to a built-in dictionary for those short names).
 *
 * Why this matters: the probe used to hardcode `/v1/images/edits`,
 * `/v1/images/generations`, `/v1/chat/completions`, `/v1/videos`. That
 * worked for OpenAI-compatible channels but failed for Replicate-routed
 * (`/replicate/v1/...`), Tencent VOD (`/tencent-vod/v1/...`), and yun's
 * vendor-specific routes. Using `endpointPaths` makes the probe portable
 * across any new-api fork without per-vendor hardcoding.
 */

export interface ResolvedEndpoint {
  /** The exact URL to POST to. May be relative or absolute. Caller
   *  prepends `baseUrl` and substitutes `{model}` if present. */
  path: string;
  /** Wire shape: how to construct the request body and interpret the
   *  response. Picked from URL/endpoint-type heuristics. */
  shape: ProbeShape;
}

// ---------------------------------------------------------------------------
// Built-in fallback dictionary
// ---------------------------------------------------------------------------

/**
 * Endpoint type -> default URL path. Used when the provider's
 * `endpointPaths` map is empty (v3) or doesn't list this endpoint type.
 * Keys are normalized to lowercase; matched case-insensitively.
 *
 * Standardized new-api types come from
 * https://github.com/QuantumNous/new-api/blob/main/relay/constant/relay_mode.go
 */
const FALLBACK_PATHS: Record<string, string> = {
  // OpenAI-compat sync
  "image-generation": "/v1/images/generations",
  "image-edit": "/v1/images/edits",
  "openai-image": "/v1/images/generations",
  "aigc-image": "/v1/images/generations",
  "aigc-image-edit": "/v1/images/edits",
  "dall-e-3": "/v1/images/generations",
  "openai": "/v1/chat/completions",
  "anthropic": "/v1/messages",
  // Short names (v3-style)
  images: "/v1/images/generations",
  edits: "/v1/images/edits",
  chat: "/v1/chat/completions",
  // OAI-compat task
  "openai-video": "/v1/videos",
  "omni-video": "/v1/videos",
  // English natural-language (link-style)
  "generate image": "/v1/images/generations",
  "edit image": "/v1/images/edits",
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the wire-shape for a probe attempt: pick the URL from the
 * provider's declared `endpointPaths` (preferred) or fall back to the
 * built-in dictionary, then categorize the URL into a probe shape.
 *
 * Returns null when the endpoint type is unknown - caller should skip
 * this attempt rather than hammering an unrelated URL.
 */
export function resolveEndpoint(opts: {
  endpointType: string;
  modelName: string;
  pricing: UpstreamPricing;
}): ResolvedEndpoint | null {
  const lower = opts.endpointType.toLowerCase();

  // Provider-declared path wins. yun lists explicit per-model paths like
  // `/replicate/v1/models/black-forest-labs/flux-kontext-pro/predictions`.
  const declared = opts.pricing.endpointPaths[opts.endpointType];
  let path = declared?.path;
  if (!path) {
    // Try lowercased lookup just in case (rare).
    for (const [k, v] of Object.entries(opts.pricing.endpointPaths)) {
      if (k.toLowerCase() === lower) {
        path = v.path;
        break;
      }
    }
  }
  if (!path) path = FALLBACK_PATHS[lower];
  if (!path) return null;

  // Substitute {model} in the path. Some providers use `:model` instead.
  path = path.replace(/\{model\}/g, opts.modelName).replace(/:model\b/g, opts.modelName);

  return {
    path,
    shape: classifyShape(path, opts.endpointType),
  };
}

/**
 * Categorize an endpoint URL into a probe shape:
 *
 *   /v1/images/edits           -> sync-edits     (multipart, 6 image[] fields)
 *   /v1/images/generations     -> sync-generations (JSON, text-to-image)
 *   /v1/chat/completions       -> openai-vendor  (chat-completions multimodal)
 *   /v1/videos[/...]           -> task           (submit + poll + download)
 *   /replicate/v1/.../predictions, /predictions, *predict*, *async*
 *                              -> task           (Replicate-style submit + poll)
 *   /v1beta/models/...:generateContent  (gemini)
 *                              -> openai-vendor  (chat-shape, gemini-native)
 *
 * Falls back to `openai-vendor` for unrecognized JSON endpoints because
 * that's the most permissive shape new-api can usually translate to.
 */
function classifyShape(path: string, endpointType: string): ProbeShape {
  const lp = path.toLowerCase();
  const lt = endpointType.toLowerCase();

  // Task routes: explicit /predictions paths (Replicate),
  // /v1/videos (OAI-compat task), or any endpoint type tagged 异步.
  if (
    lp.includes("/predictions") ||
    lp.includes("/v1/videos") ||
    lp.includes("/v1/video/") ||
    /async|task|submit/.test(lp) ||
    lt.includes("异步") ||
    lt.includes("视频") ||
    lt === "openai-video" ||
    lt === "omni-video"
  ) {
    return "task";
  }
  // Explicit edits route -> multipart.
  if (lp.includes("/images/edits") || lt.includes("edit") || lt.includes("修图") || lt.includes("扩图")) {
    return "sync-edits";
  }
  // Generations route -> JSON text-to-image.
  if (lp.includes("/images/generations") || lt === "image-generation" || lt === "images" || lt === "openai-image" || lt === "aigc-image" || lt === "dall-e-3" || lt.includes("生图")) {
    return "sync-generations";
  }
  // Chat completions -> multimodal openai-vendor.
  if (lp.includes("/chat/completions") || lp.includes("/messages") || lp.includes(":generatecontent") || lt === "openai" || lt === "anthropic" || lt === "gemini" || lt === "chat") {
    return "openai-vendor";
  }
  // Default fallback.
  return "openai-vendor";
}
