import type { Channel } from "@core/types";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";

const TOKEN_NAME_MAX_BYTES = 30;

// a7 lane tokens are `<merchantId>-<model>`, newapi group tokens are
// `<group>-<prefix>` cut to 30 bytes (the suffix always survives the cut).
export function isOurTokenName(
  kind: "newapi" | "a7api",
  name: string,
  prefix: string,
): boolean {
  if (kind === "a7api") return /^\d+-/.test(name);
  if (name.endsWith(`-${prefix}`)) return true;
  return (
    Buffer.byteLength(name, "utf8") === TOKEN_NAME_MAX_BYTES &&
    name.endsWith(prefix)
  );
}

const normUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

export function channelsForProvider(
  channels: Channel[],
  providerName: string,
  baseUrl: string,
): Channel[] {
  const base = normUrl(baseUrl);
  return channels.filter(
    (c) =>
      c.tag === providerName ||
      (typeof c.base_url === "string" && normUrl(c.base_url) === base),
  );
}

// Lane token `<merchantId>-<model>` to the channels of that merchant: the
// channel group ends in `-<sanitized model>` and the rest ends in the id.
export function laneChannelIds(
  channels: Channel[],
  tokenName: string,
): Set<number> | null {
  const m = /^(\d+)-(.+)$/.exec(tokenName);
  if (!m) return null;
  const id = m[1];
  const ids = new Set<number>();
  for (const c of channels) {
    if (c.id == null || !c.group) continue;
    const exposed = c.models.split(",")[0]?.trim().toLowerCase();
    if (!exposed) continue;
    const suffix = `-${sanitizeGroupName(exposed)}`;
    if (!c.group.endsWith(suffix)) continue;
    if (/(\d+)$/.exec(c.group.slice(0, -suffix.length))?.[1] === id)
      ids.add(c.id);
  }
  return ids.size > 0 ? ids : null;
}
