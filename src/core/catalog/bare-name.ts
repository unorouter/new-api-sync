/**
 * vendor/X:suffix → lowercase bare so cross-upstream casing collapses:
 *   "openai/gpt-oss-120b:free"     → "gpt-oss-120b"
 *   "@cf/meta/llama-3.3-70b-fp8"   → "llama-3.3-70b-fp8"  (multi-segment: keep last)
 *   "MiniMax-M2.5"                 → "minimax-m2.5"
 * Original ID lives in each channel's model_mapping so the gateway forwards it intact.
 * Uses the LAST slash so multi-segment ids (Cloudflare "@cf/{org}/{model}") collapse to
 * the model; single-segment vendor/model is unaffected (last slash == first).
 */
export function toBareName(upstreamId: string): string {
  const slash = upstreamId.lastIndexOf("/");
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
  /** 2, 3, ... for a further upstream ID that resolved to the same name; it gets its
   *  own numbered lane instead of being dropped. */
  lane?: number;
}

/** Bare-name collision = same bare maps to ≥2 distinct upstream IDs (dups don't count). */
export function resolveBareNames(
  upstreamIds: string[],
  userMapping: Record<string, string> | undefined,
  opts: { laneDuplicates?: boolean } = {},
): BareNameResolution[] {
  const bareToUpstreams = new Map<string, Set<string>>();
  for (const id of upstreamIds) {
    const bare = toBareName(id);
    if (!bareToUpstreams.has(bare)) bareToUpstreams.set(bare, new Set());
    bareToUpstreams.get(bare)!.add(id);
  }

  const seen = new Map<string, number>();
  const result: BareNameResolution[] = [];
  for (const id of upstreamIds) {
    const bare = toBareName(id);
    const collides = (bareToUpstreams.get(bare)?.size ?? 0) > 1;
    const fallback = (collides ? id : bare).toLowerCase();
    const mapped = userMapping?.[collides ? id : bare];
    const exposed = (mapped ?? fallback).toLowerCase();
    const count = (seen.get(exposed) ?? 0) + 1;
    seen.set(exposed, count);
    if (count === 1) result.push({ exposed, upstream: id });
    else if (opts.laneDuplicates)
      result.push({ exposed, upstream: id, lane: count });
  }
  return result;
}

/** exposed → upstream, only where rewriting is needed. new-api substitutes on outbound. */
export function buildChannelModelMapping(
  resolutions: BareNameResolution[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const r of resolutions) {
    if (!r.lane && r.exposed !== r.upstream) mapping[r.exposed] = r.upstream;
  }
  return mapping;
}
