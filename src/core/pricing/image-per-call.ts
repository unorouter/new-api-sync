// Cost-estimation helpers for media (image/video/audio) models that bill PER TOKEN upstream.
//
// new-api settles a per-token image request as
//   quota = (prompt + image*imageRatio + completion*completionRatio) * modelRatio * groupRatio * N
// so the real cost is dominated by completionRatio x the (large) image-output token volume, NOT by
// modelRatio alone. The pre-test cap compares cost in modelRatio units, which undercounts a
// per-token image model's true cost and wrongly drops cheap providers.
//
// We resolve this by pricing a representative single generation in ACTUAL DOLLARS PER CALL, using the
// codebase convention modelRatio*2 == $/1M tokens (see provider.ts usd()). The cap then compares
// charge-USD vs canonical-USD: a dimensionless, cost-true number (~$0.02/call for gpt-image-2,
// matching a live upstream console), instead of an abstract ratio that mixes units. The token profile is
// approximate ON PURPOSE: it only tunes the cap's keep/drop decision, never the money billed (billing
// stays the exact per-token formula above, which is size-accurate end to end).

// Representative single image generation. Calibrated against a live upstream console: gpt-image-2
// generations report ~765 output tokens regardless of prompt (the image IS the output), with a
// small prompt. Raising OUTPUT makes the cap/derived-price treat per-token image models as costlier.
export const IMAGE_REPRESENTATIVE_PROMPT_TOKENS = 96;
export const IMAGE_REPRESENTATIVE_OUTPUT_TOKENS = 765;

// modelRatio*2 == $/1M tokens (codebase convention). Cost of one representative generation in dollars:
//   $/call = (promptTok * modelRatio*2 + completionTok * modelRatio*2*completionRatio) / 1e6
// e.g. gpt-image-2 (modelRatio 2.5, completionRatio 6): (96 + 765*6) * 5 / 1e6 ~= $0.0234 per
// call, matching the live console's $0.0232 (48p/765c) to the cent.
export function imagePerCallUsd(args: {
  modelRatio: number;
  completionRatio: number;
}): number {
  const inputUsdPerM = args.modelRatio * 2;
  const outputUsdPerM = args.modelRatio * 2 * args.completionRatio;
  const p = IMAGE_REPRESENTATIVE_PROMPT_TOKENS;
  const c = IMAGE_REPRESENTATIVE_OUTPUT_TOKENS;
  return (p * inputUsdPerM + c * outputUsdPerM) / 1_000_000;
}

// A media model (image/video/audio/embedding) billed per token upstream, i.e. not fixed per-request.
export function isPerTokenImage(modelType: string, isFixed: boolean): boolean {
  return modelType !== "text" && !isFixed;
}

// new-api bills ONE billing type per model NAME (GetModelPrice keys by name, no channel dimension).
// The SAME image model is served per-token (quota_type 0: ratio+completionRatio, HONORS size/quality
// params) by some relays and per-call flat (quota_type 1: model_price, IGNORES params) by others.
// To avoid the collision we publish per-call image occurrences under this suffix, keeping per-token
// (params) on the clean base name. toBareName strips `:suffix`, so canonical pricing still resolves
// to the base model.
// The split itself (which per-call occurrences become `:flat`) is cross-provider, so it lives in the
// pipeline post-pass `applyFlatVariantSplit` (sync/pipeline/providers.ts), not here.
export const FLAT_VARIANT_SUFFIX = ":flat";

// A resolution-grid billing type (quotaType 4, ModelGridPricing) is distinct from per-token and
// per-call; a grid on a shared name deletes the base's ratios. Grid occurrences publish under this
// suffix so a per-token/per-call twin keeps its own name. Split in `applyGridVariantSplit`.
export const GRID_VARIANT_SUFFIX = ":grid";
