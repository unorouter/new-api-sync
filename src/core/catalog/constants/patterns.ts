import type { Channel } from "@core/types";
import micromatch from "micromatch";

export const CLAUDE_CONTEXT_1M_SUFFIX = "[1m]";

// `[1m]` aliases exist only to route the 1M-context beta; they carry no price
// or metadata of their own.
export function isRoutingOnlyAlias(modelName: string): boolean {
  return modelName.endsWith(CLAUDE_CONTEXT_1M_SUFFIX);
}

export function modelsOnChannels(
  channels: Channel[],
  opts: { enabledOnly: boolean; includeAliases: boolean },
): Set<string> {
  const models = new Set<string>();
  for (const ch of channels) {
    if (opts.enabledOnly && ch.status !== 1) continue;
    for (const m of parseModelList(ch.models))
      if (opts.includeAliases || !isRoutingOnlyAlias(m)) models.add(m);
  }
  return models;
}

export function groupsOnChannels(
  channels: Channel[],
  opts: { enabledOnly: boolean },
): Set<string> {
  const groups = new Set<string>();
  for (const ch of channels) {
    if (opts.enabledOnly && ch.status !== 1) continue;
    for (const g of parseModelList(ch.group ?? "")) groups.add(g);
  }
  return groups;
}

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
