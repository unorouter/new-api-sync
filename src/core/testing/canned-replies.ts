// A provider's own notice served as the model's answer with a clean 200 (a banned
// upstream account, a product assistant resold as a chat model). Nothing about
// the status or the envelope says the lane is broken, so the text is the only
// evidence. Lowercase; mirrors `replyRules` in new-api
// service/upstream_reply_class.go.
const CANNED_REPLY_MARKERS: readonly string[] = [
  "flagged as having abnormal activity",
  "orcaterm",
  "如果您有服务器运维、云资源管理",
  "please retry later, or reduce the request parameters/content",
];
// A long answer that quotes one of these sentences is the model talking.
const CANNED_REPLY_MAX_CHARS = 600;

export function cannedReplyMarker(
  replies: readonly (string | null | undefined)[],
): string | undefined {
  for (const reply of replies) {
    const text = (reply ?? "").trim().toLowerCase();
    if (!text || text.length > CANNED_REPLY_MAX_CHARS) continue;
    const marker = CANNED_REPLY_MARKERS.find((m) => text.includes(m));
    if (marker) return marker;
  }
  return undefined;
}

const REPLY_TEXT_KEYS: ReadonlySet<string> = new Set([
  "content",
  "text",
  "output_text",
]);

/** Every answer string in a parsed response body, whichever wire it came on. */
export function replyTexts(data: unknown, depth = 0): string[] {
  if (depth > 8 || data === null || typeof data !== "object") return [];
  if (Array.isArray(data))
    return data.flatMap((item) => replyTexts(item, depth + 1));
  return Object.entries(data).flatMap(([key, value]) =>
    typeof value === "string"
      ? REPLY_TEXT_KEYS.has(key)
        ? [value]
        : []
      : replyTexts(value, depth + 1),
  );
}

const LINK_RE = /(?:https?:\/\/|www\.)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

// A host splicing ads or scraped text into answers repeats the same domain across
// unrelated questions (sum, JSON, history); no real model cites one site in all.
export function injectedLinkMarker(
  replies: readonly (string | null | undefined)[],
  minReplies = 2,
): string | undefined {
  const seen = new Map<string, number>();
  for (const reply of replies) {
    const hosts = new Set(
      [...(reply ?? "").matchAll(LINK_RE)].map((m) =>
        (m[1] ?? "").toLowerCase().replace(/^www\./, ""),
      ),
    );
    for (const h of hosts) seen.set(h, (seen.get(h) ?? 0) + 1);
  }
  for (const [host, n] of seen)
    if (n >= minReplies) return `${host} in ${n} replies`;
  return undefined;
}
