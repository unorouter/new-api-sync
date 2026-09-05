import micromatch from "micromatch";
import { CHANNEL_TYPES } from "./channel-types";

/** Substring for bare patterns; globs go through micromatch. */
function matchBlacklistEntry(text: string, pattern: string): boolean {
  if (pattern.includes("*")) return micromatch.isMatch(text, pattern);
  return text.includes(pattern);
}

export function matchesBlacklist(
  text: string | null | undefined,
  blacklist?: string[],
  scope?: string,
): boolean {
  if (!blacklist?.length || !text) return false;
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

/**
 * `groupMapping`: rewrite fragments of an upstream group label. Each key is a
 * case-insensitive substring, its value replaces just that substring, so the
 * rest of the label survives. Scoped keys (`provider/fragment`) run before bare
 * ones, longer fragments before shorter. Unmatched labels come back unchanged.
 */
export function spliceGroupLabel(
  label: string,
  scope: string,
  mapping: Record<string, string>,
): string {
  const s = scope.toLowerCase();
  const scoped: Array<[string, string]> = [];
  const bare: Array<[string, string]> = [];
  for (const [rawKey, value] of Object.entries(mapping)) {
    const key = rawKey.toLowerCase();
    const slashIdx = key.indexOf("/");
    if (slashIdx === -1) {
      if (key) bare.push([key, value]);
      continue;
    }
    if (key.slice(0, slashIdx) !== s) continue;
    const fragment = key.slice(slashIdx + 1);
    if (fragment) scoped.push([fragment, value]);
  }
  const longestFirst = (a: [string, string], b: [string, string]) =>
    b[0].length - a[0].length;
  let out = label;
  for (const [fragment, value] of [
    ...scoped.sort(longestFirst),
    ...bare.sort(longestFirst),
  ])
    out = replaceFragment(out, fragment, value);
  return out;
}

function replaceFragment(
  text: string,
  fragment: string,
  value: string,
): string {
  const lower = text.toLowerCase();
  let idx = lower.indexOf(fragment);
  if (idx === -1) return text;
  let out = "";
  let cursor = 0;
  while (idx !== -1) {
    out += text.slice(cursor, idx) + value;
    cursor = idx + fragment.length;
    idx = lower.indexOf(fragment, cursor);
  }
  return out + text.slice(cursor);
}

/** Ensure a sanitized base is unique within a provider: 2nd+ collision gets a `-N` suffix. */
export function dedupBase(base: string, used: Map<string, number>): string {
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count > 0 ? `${base}-${count + 1}` : base;
}

/** Slugify: drop CJK, non-slug chars -> single dash, trim. CJK-only -> FNV-1a hash. */
export function sanitizeGroupName(name: string): string {
  const slug = name
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (slug) return slug;
  let h = 0x811c9dc5;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
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
