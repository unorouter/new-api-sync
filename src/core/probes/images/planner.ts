import type { UpstreamPricing } from "@core/vendors/newapi/types";
import type { ProbeKind } from "./candidates";
import { resolveEndpoint } from "./endpoint-resolver";
import type { ChannelResult, ProbeShape } from "./store";

/**
 * Names that need refs regardless of advertised endpoint. Many edit-only models
 * on resellers are mis-listed under image-generation; probing text-only yields
 * "Missing required key: image" 400s. Adding edit-style shapes for these names
 * exercises the multipart + chat-multimodal paths that actually carry refs.
 */
const NAME_REQUIRES_REFS = [
  "edit",
  "kontext",
  "i2i",
  "i2v",
  "img2img",
  "image-to-image",
  "image-to-video",
  "redux",
  "remix",
];

export interface ProbeStep {
  shape: ProbeShape;
  /** Provider-declared URL path. Undefined => use probe module's default. */
  path?: string;
}

/**
 * One (shape, path) step per declared endpoint type, deduped by `shape|path`.
 * Multi-endpoint models get one attempt per pair; errors don't bill.
 *
 * Name-based override (NAME_REQUIRES_REFS): edit/kontext/i2i/etc models add
 * sync-edits + openai-vendor steps even when the gateway only advertises
 * text-to-image, because text-only triggers "Missing required key: image".
 * Dedup by shape prevents double-billing openai-vendor on *edit* models that
 * already declared the `openai` endpoint.
 */
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

/**
 * Gateway can't translate any wire shape to upstream (e.g. aigc routes Imagen
 * to Gemini/OpenAI but Imagen actually wants :predict). Both routes reject:
 * OAI->Gemini gives "contents is required"; Gemini multimodal gives
 * "Unknown name contents/instances/parts/generationConfig/safetySettings".
 * Gateway routing is global, so one signature means every group will fail
 * the same way — abort the model.
 */
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

/** Only sync-generations is text-to-image; the rest carry the 6 refs. */
export function shapeHasImageInputs(shape: ProbeShape): boolean {
  return shape !== "sync-generations";
}
