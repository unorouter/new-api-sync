import type { UpstreamPricing } from "@core/vendors/newapi/types";
import type { ProbeShape } from "./store";

export const SHARED_OAI_PATHS: readonly string[] = [
  "/v1/images/edits",
  "/v1/images/generations",
  "/v1/chat/completions",
  "/v1/videos",
];

export interface ResolvedEndpoint {
  path: string;
  shape: ProbeShape;
}

const FALLBACK_PATHS: Record<string, string> = {
  "image-generation": "/v1/images/generations",
  "image-edit": "/v1/images/edits",
  "openai-image": "/v1/images/generations",
  "aigc-image": "/v1/images/generations",
  "aigc-image-edit": "/v1/images/edits",
  "dall-e-3": "/v1/images/generations",
  openai: "/v1/chat/completions",
  images: "/v1/images/generations",
  edits: "/v1/images/edits",
  chat: "/v1/chat/completions",
  "openai-video": "/v1/videos",
  "omni-video": "/v1/videos",
  "generate image": "/v1/images/generations",
  "edit image": "/v1/images/edits",
};

export function resolveEndpoint(opts: {
  endpointType: string;
  modelName: string;
  pricing: UpstreamPricing;
}): ResolvedEndpoint | null {
  const lower = opts.endpointType.toLowerCase();
  let path = opts.pricing.endpointPaths[opts.endpointType]?.path;
  if (!path) {
    for (const [k, v] of Object.entries(opts.pricing.endpointPaths)) {
      if (k.toLowerCase() === lower) {
        path = v.path;
        break;
      }
    }
  }
  if (!path) path = FALLBACK_PATHS[lower];
  if (!path) return null;

  path = path
    .replace(/\{model\}/g, opts.modelName)
    .replace(/:model\b/g, opts.modelName);
  return { path, shape: classifyShape(path, opts.endpointType) };
}

function classifyShape(path: string, endpointType: string): ProbeShape {
  const lp = path.toLowerCase();
  const lt = endpointType.toLowerCase();

  if (
    lp.includes("/predictions") ||
    lp.includes("/v1/videos") ||
    lp.includes("/v1/video/") ||
    /async|task|submit/.test(lp) ||
    lt.includes("异步") ||
    lt.includes("视频") ||
    lt === "openai-video" ||
    lt === "omni-video"
  )
    return "task";

  if (
    lp.includes("/images/edits") ||
    lt.includes("edit") ||
    lt.includes("修图") ||
    lt.includes("扩图")
  )
    return "sync-edits";

  if (
    lp.includes("/images/generations") ||
    lt === "image-generation" ||
    lt === "images" ||
    lt === "openai-image" ||
    lt === "aigc-image" ||
    lt === "dall-e-3" ||
    lt.includes("生图")
  )
    return "sync-generations";

  return "openai-vendor";
}
