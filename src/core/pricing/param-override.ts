import { matchesAnyPattern } from "@core/catalog/constants/patterns";

export interface ChannelParamOverrideRule {
  channels: string[];
  operations: Record<string, unknown>[];
}

// Merges the operations of every rule whose channel glob matches onto the
// override a channel already carries (thinking-disable, Claude 1m, ...).
export function applyChannelParamOverride(
  channelName: string,
  base: string | undefined,
  rules: ChannelParamOverrideRule[] | undefined,
): string | undefined {
  const extra = (rules ?? [])
    .filter((r) => matchesAnyPattern(channelName, r.channels))
    .flatMap((r) => r.operations);
  if (extra.length === 0) return base;

  let parsed: Record<string, unknown> = {};
  if (base) {
    try {
      const v: unknown = JSON.parse(base);
      if (v && typeof v === "object" && !Array.isArray(v))
        parsed = { ...(v as Record<string, unknown>) };
    } catch {
      parsed = {};
    }
  }
  const existing = Array.isArray(parsed.operations)
    ? (parsed.operations as unknown[])
    : [];
  return JSON.stringify({ ...parsed, operations: [...existing, ...extra] });
}
