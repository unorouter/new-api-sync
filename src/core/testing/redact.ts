import type { TestExchange } from "./types";

const SENSITIVE_HEADERS = ["authorization", "x-api-key"];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^\[?[0-9a-fA-F:]+\]?$/;

function isPrivateIPv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const a = +m[1]!,
    b = +m[2]!;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

function maskHostnameLabel(label: string): string {
  if (label.length <= 1) return label;
  return label[0] + "*".repeat(label.length - 1);
}

function maskHostname(host: string): string {
  if (!host) return host;
  // Public IPs leak provider identity, so mask them. Private/loopback IPs
  // (RFC1918, 127.x, link-local) are dev/internal and stay readable.
  if (IPV4_RE.test(host)) {
    return isPrivateIPv4(host) ? host : "***.***.***.***";
  }
  if (IPV6_RE.test(host)) return host;
  const labels = host.split(".");
  if (labels.length === 1) return labels[0]!;
  // Mask everything except the final label (TLD).
  return labels
    .slice(0, -1)
    .map(maskHostnameLabel)
    .concat(labels[labels.length - 1]!)
    .join(".");
}

export function redactUrl(url: string): string {
  let out = url.replace(/([?&])key=[^&]+/g, "$1key=[REDACTED]");
  try {
    const parsed = new URL(out);
    parsed.hostname = maskHostname(parsed.hostname);
    out = parsed.toString();
  } catch {
    // Non-absolute URL (e.g. blank string or bare path); leave hostname alone.
  }
  return out;
}

function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k in headers) {
    out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase())
      ? "[REDACTED]"
      : headers[k]!;
  }
  return out;
}

export function redactExchange(ex: TestExchange): TestExchange {
  return {
    ...ex,
    request: {
      url: redactUrl(ex.request.url),
      headers: redactHeaders(ex.request.headers),
      body: ex.request.body,
    },
  };
}
