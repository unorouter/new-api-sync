/**
 * Slash-only bare name extractor for upstream model IDs.
 *   "anthropic/claude-opus-4.5" -> "claude-opus-4.5"
 *   "openai/gpt-oss-120b:free"  -> "gpt-oss-120b:free"  (preserves :suffix)
 *
 * Distinct from `toBareName` in bare-name.ts which also strips `:suffix`.
 * Pricing sources index by both slash-stripped and full keys to support
 * fuzzy lookup; the `:suffix` carries pricing-relevant info (e.g. `:free`).
 */
export function bareSlash(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash >= 0 ? key.slice(slash + 1) : key;
}
