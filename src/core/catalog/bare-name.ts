/**
 * Strip the `vendor/` prefix and any `:suffix` (e.g. `:free`) from a full
 * upstream model ID to produce a user-facing bare name. The result is
 * lowercased so the same model exposed by different upstreams with
 * different casing (e.g. NVIDIA `minimaxai/minimax-m2.5`, yun `MiniMax-M2.5`)
 * collapses into one catalogue entry. The original upstream ID is preserved
 * separately on each channel's model_mapping so the gateway forwards the
 * exact form upstream expects.
 *   "openai/gpt-oss-120b:free"    -> "gpt-oss-120b"
 *   "MiniMax-M2.5"                -> "minimax-m2.5"
 *   "moonshotai/kimi-k2.5"        -> "kimi-k2.5"
 */
export function toBareName(upstreamId: string): string {
  const slash = upstreamId.indexOf("/");
  const withoutVendor = slash >= 0 ? upstreamId.slice(slash + 1) : upstreamId;
  const colon = withoutVendor.indexOf(":");
  const bare = colon >= 0 ? withoutVendor.slice(0, colon) : withoutVendor;
  return bare.toLowerCase();
}

export interface BareNameResolution {
  /** What users call on the gateway (bare name, or full ID if it collides). */
  exposed: string;
  /** What must be forwarded upstream (the original full ID). */
  upstream: string;
}

/**
 * Resolve a list of upstream model IDs into exposed/upstream pairs,
 * keeping the full ID for bare-name collisions so both remain addressable.
 * User `modelMapping` is applied on top of the bare name (rename only).
 */
export function resolveBareNames(
  upstreamIds: string[],
  userMapping: Record<string, string> | undefined,
): BareNameResolution[] {
  // Collision = the same bare name maps to *different* upstream IDs.
  // Duplicate upstream IDs (NVIDIA's /v1/models returns some ids twice, e.g.
  // openai/gpt-oss-120b) aren't collisions — they're the same model. Count
  // the set of distinct upstream IDs per bare name, not raw occurrences.
  const bareToUpstreams = new Map<string, Set<string>>();
  for (const id of upstreamIds) {
    const bare = toBareName(id);
    if (!bareToUpstreams.has(bare)) bareToUpstreams.set(bare, new Set());
    bareToUpstreams.get(bare)!.add(id);
  }

  const seen = new Set<string>();
  const result: BareNameResolution[] = [];
  for (const id of upstreamIds) {
    const bare = toBareName(id);
    const collides = (bareToUpstreams.get(bare)?.size ?? 0) > 1;
    // Exposed names are always lowercase. The upstream form is preserved
    // separately in `result[].upstream` and used by `buildChannelModelMapping`
    // so the gateway forwards the upstream's exact casing back to it.
    const fallback = (collides ? id : bare).toLowerCase();
    const mapped = userMapping?.[collides ? id : bare];
    const exposed = (mapped ?? fallback).toLowerCase();
    if (seen.has(exposed)) continue;
    seen.add(exposed);
    result.push({ exposed, upstream: id });
  }
  return result;
}

/**
 * Build a `model_mapping` JSON payload for a new-api channel from a list
 * of resolutions: exposed name → upstream full ID. Only includes entries
 * where exposed !== upstream (i.e. where rewriting is actually needed).
 * new-api's adaptor reads this map and substitutes the upstream ID on its
 * outbound request, so users can call the bare name on the gateway.
 */
export function buildChannelModelMapping(
  resolutions: BareNameResolution[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const r of resolutions) {
    if (r.exposed !== r.upstream) mapping[r.exposed] = r.upstream;
  }
  return mapping;
}
