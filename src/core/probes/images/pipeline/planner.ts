import type { UpstreamPricing } from "@core/vendors/newapi/types";
import type { ProbeKind } from "./candidates";
import { resolveEndpoint } from "../endpoint-resolver";
import type { ChannelResult, ProbeShape } from "../io/store";

/** Edit-only models mis-listed as image-generation: text-only probes 400 on "Missing required key: image". */
// prettier-ignore
const NAME_REQUIRES_REFS = ["edit","kontext","i2i","i2v","img2img","image-to-image","image-to-video","redux","remix"];

export interface ProbeStep {
  shape: ProbeShape;
  /** Undefined = use probe module's default. */
  path?: string;
}

/** One step per endpoint type, deduped by `shape|path`. NAME_REQUIRES_REFS adds sync-edits+openai-vendor for edit-style names. */
export function probeStepsFor(opts: {
  endpointTypes: string[];
  primary: ProbeKind;
  modelName: string;
  pricing: UpstreamPricing;
}): ProbeStep[] {
  const seen = new Set<string>();
  const steps: ProbeStep[] = [];
  const add = (shape: ProbeShape, path?: string) => {
    const key = `${shape}|${path ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ shape, path });
  };

  for (const e of opts.endpointTypes) {
    const resolved = resolveEndpoint({
      endpointType: e,
      modelName: opts.modelName,
      pricing: opts.pricing,
    });
    if (resolved) add(resolved.shape, resolved.path);
  }

  const lowerName = opts.modelName.toLowerCase();
  if (NAME_REQUIRES_REFS.some((k) => lowerName.includes(k))) {
    const haveShape = (s: ProbeShape) => steps.some((st) => st.shape === s);
    if (!haveShape("sync-edits")) add("sync-edits");
    if (!haveShape("openai-vendor")) add("openai-vendor");
  }

  if (steps.length === 0) {
    if (opts.primary === "sync") add("sync-edits");
    else if (opts.primary === "openai-vendor") add("openai-vendor");
    else add("task");
  }
  return steps;
}

/** "contents is required" / "Unknown name contents..." = gateway can't reach this model on any group. */
export function isGatewayBrokenSignature(attempt: ChannelResult): boolean {
  if (attempt.errorClass !== "ref_count_rejected") return false;
  const body =
    attempt.exchange.response == null
      ? ""
      : typeof attempt.exchange.response === "string"
        ? attempt.exchange.response
        : JSON.stringify(attempt.exchange.response);
  return (
    /contents is required/i.test(body) ||
    /Unknown name "(?:contents|instances|parts|generationConfig|safetySettings)"/.test(
      body,
    )
  );
}

export function shapeToKind(shape: ProbeShape): ProbeKind {
  if (shape === "sync-edits" || shape === "sync-generations") return "sync";
  if (shape === "task") return "task";
  return "openai-vendor";
}

export function shapeHasImageInputs(shape: ProbeShape): boolean {
  return shape !== "sync-generations"; // only sync-generations is t2i
}
