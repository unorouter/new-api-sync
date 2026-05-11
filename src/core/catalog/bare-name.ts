/**
 * vendor/X:suffix → lowercase bare so cross-upstream casing collapses:
 *   "openai/gpt-oss-120b:free"  → "gpt-oss-120b"
 *   "MiniMax-M2.5"              → "minimax-m2.5"
 * Original ID lives in each channel's model_mapping so the gateway forwards it intact.
 */
export function toBareName(upstreamId: string): string {
  const slash = upstreamId.indexOf("/");
  const withoutVendor = slash >= 0 ? upstreamId.slice(slash + 1) : upstreamId;
  const colon = withoutVendor.indexOf(":");
  const bare = colon >= 0 ? withoutVendor.slice(0, colon) : withoutVendor;
  return bare.toLowerCase();
}

interface BareNameResolution {
  /** Gateway-facing name (bare; falls back to full ID on collision). */
  exposed: string;
  /** Original full ID, forwarded upstream. */
  upstream: string;
}

/** Bare-name collision = same bare maps to ≥2 distinct upstream IDs (dups don't count). */
export function resolveBareNames(
  upstreamIds: string[],
  userMapping: Record<string, string> | undefined,
): BareNameResolution[] {
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
    const fallback = (collides ? id : bare).toLowerCase();
    const mapped = userMapping?.[collides ? id : bare];
    const exposed = (mapped ?? fallback).toLowerCase();
    if (seen.has(exposed)) continue;
    seen.add(exposed);
    result.push({ exposed, upstream: id });
  }
  return result;
}

/** exposed → upstream, only where rewriting is needed. new-api substitutes on outbound. */
export function buildChannelModelMapping(
  resolutions: BareNameResolution[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const r of resolutions) {
    if (r.exposed !== r.upstream) mapping[r.exposed] = r.upstream;
  }
  return mapping;
}
