import { t } from "@server/i18n";

const UNIT_SECONDS: Record<string, number> = {
  m: 60,
  h: 3600,
  d: 86400,
};

export function parseSince(value: string): number {
  const m = /^(\d+)([mhd])$/.exec(value.trim());
  const unit = m ? UNIT_SECONDS[m[2] ?? ""] : undefined;
  if (!m || !unit) throw new Error(t("ERROR.INVALID_DURATION", { value }));
  return Number(m[1]) * unit;
}

// The end sits a minute back so requests still streaming on either side do
// not read as unmatched.
export function makeWindow(sinceSeconds: number): {
  start: number;
  end: number;
} {
  const end = Math.floor(Date.now() / 1000) - 60;
  return { start: end - sinceSeconds, end };
}

// ISO date or datetime, or unix seconds; "now" for the open end.
export function parseInstant(value: string): number {
  const v = value.trim();
  if (v === "now") return Math.floor(Date.now() / 1000) - 60;
  if (/^\d{9,}$/.test(v)) return Number(v);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(ms))
    throw new Error(t("ERROR.INVALID_INSTANT", { value }));
  return Math.floor(ms / 1000);
}

export function explicitWindow(
  from: string,
  to: string,
): { start: number; end: number } {
  const start = parseInstant(from);
  const end = Math.min(parseInstant(to), Math.floor(Date.now() / 1000) - 60);
  if (end <= start) throw new Error(t("ERROR.INVALID_INSTANT", { value: to }));
  return { start, end };
}
