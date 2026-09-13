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
