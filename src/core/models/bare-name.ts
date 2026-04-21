/**
 * Strip the `vendor/` prefix and any `:suffix` (e.g. `:free`) from a full
 * upstream model ID to produce a user-facing bare name.
 *   "openai/gpt-oss-120b:free"    -> "gpt-oss-120b"
 *   "moonshotai/kimi-k2.5"        -> "kimi-k2.5"
 *   "stabilityai/stable-diffusion" -> "stable-diffusion"
 */
export function toBareName(upstreamId: string): string {
  const slash = upstreamId.indexOf("/");
  const withoutVendor = slash >= 0 ? upstreamId.slice(slash + 1) : upstreamId;
  const colon = withoutVendor.indexOf(":");
  return colon >= 0 ? withoutVendor.slice(0, colon) : withoutVendor;
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
  const bareCount = new Map<string, number>();
  for (const id of upstreamIds) {
    const bare = toBareName(id);
    bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const result: BareNameResolution[] = [];
  for (const id of upstreamIds) {
    const bare = toBareName(id);
    const collides = (bareCount.get(bare) ?? 0) > 1;
    const exposed = userMapping?.[collides ? id : bare] ?? (collides ? id : bare);
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
