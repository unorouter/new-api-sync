import micromatch from "micromatch";
import { CHANNEL_TYPES } from "./channel-types";

// Blacklist matches use substring semantics for non-glob patterns: a
// blacklist entry "kiro" should catch group/channel names like
// "cc-kiro", "claude_kiro", etc. Exact-match semantics is the right
// default for model names (where exact match is what users expect),
// but for blacklist entries against group/channel names we want
// substring match, since the user typically doesn't know the exact
// upstream-side naming. Glob patterns ("*-kiro-*") still go through
// micromatch.
function matchBlacklistEntry(text: string, pattern: string): boolean {
  if (pattern.includes("*")) return micromatch.isMatch(text, pattern);
  return text.includes(pattern);
}

export function matchesBlacklist(
  text: string,
  blacklist?: string[],
  scope?: string,
): boolean {
  if (!blacklist?.length) return false;
  const t = text.toLowerCase();
  const s = scope?.toLowerCase();
  return blacklist.some((raw) => {
    const pattern = raw.toLowerCase();
    const slashIdx = pattern.indexOf("/");
    if (slashIdx !== -1 && s !== undefined) {
      const scopePart = pattern.slice(0, slashIdx);
      const textPart = pattern.slice(slashIdx + 1);
      return s === scopePart && matchBlacklistEntry(t, textPart);
    }
    if (slashIdx !== -1) return false;
    return matchBlacklistEntry(t, pattern);
  });
}

export function matchesAnyPattern(name: string, patterns: string[]): boolean {
  const n = name.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    if (!p.includes("*")) return n === p;
    return micromatch.isMatch(n, p);
  });
}

export function parseModelList(csv: string): string[] {
  return csv
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export function buildReverseMapping(
  mapping: Record<string, string>,
): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [original, mapped] of Object.entries(mapping)) {
    reverse.set(mapped, original);
  }
  return reverse;
}

export function sanitizeGroupName(name: string): string {
  // 1. Drop CJK ideographs entirely (channel names need to round-trip through
  //    new-api's slug rules; we keep the latin/arabic part as the meaningful
  //    handle).
  // 2. Replace runs of anything that isn't [a-z0-9._-] with a single dash so
  //    pipe/space/slash group names like "\u4e2d\u6587 | English" sanitize to
  //    "English" instead of leaking " | " into the channel name and producing
  //    invalid payloads like " | -pol-openai".
  // 3. Collapse and trim dashes.
  // 4. Empty result -> deterministic short hash of the original input, so
  //    multiple groups whose names sanitize to "" don't all collide on the
  //    same channel name (the emit.ts collision check would throw).
  const sanitized = name
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (sanitized) return sanitized;
  // FNV-1a 32-bit. 6 hex chars is enough to disambiguate the handful of
  // CJK-only / punctuation-only groups any single upstream is likely to ship.
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `g-${(h >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`;
}

export const SUB2API_PLATFORM_CHANNEL_TYPES: Record<string, number> = {
  anthropic: CHANNEL_TYPES.ANTHROPIC,
  gemini: CHANNEL_TYPES.GEMINI,
  openai: CHANNEL_TYPES.OPENAI,
};

export const VENDOR_TO_SUB2API_PLATFORMS: Record<string, string[]> = {
  google: ["gemini", "antigravity"],
  anthropic: ["anthropic"],
  openai: ["openai"],
};

export const SUB2API_PLATFORM_TO_VENDOR: Record<string, string> =
  Object.fromEntries(
    Object.entries(VENDOR_TO_SUB2API_PLATFORMS).flatMap(([vendor, platforms]) =>
      platforms.map((platform) => [platform, vendor]),
    ),
  );
