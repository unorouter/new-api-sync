import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { consola } from "consola";

/**
 * Save the actual generated image bytes from a probe response so the user
 * can eyeball the output later. Without this, only the JSON response (which
 * carries either a soon-to-expire CDN URL or base64) lands on disk - and
 * URL responses go stale within hours, leaving no way to qualitatively
 * compare models after the fact.
 *
 * Walks the response object recursively for the two shapes vendors actually
 * return:
 *   1. `{ url: "https://..." }`   - download via fetch
 *   2. `{ b64_json: "iVBOR..." }` - decode base64 directly
 *
 * Returns the absolute paths of the files written. Failures (URL expired,
 * decode error, write error) are logged at debug level and otherwise
 * swallowed - we never want a download problem to fail an otherwise-passing
 * probe.
 */
export async function saveResponseImages(opts: {
  response: unknown;
  /** `logs/images/<provider>/<model>/` */
  dir: string;
  /** Per-attempt timestamp + channel-id used to disambiguate filenames. */
  basenamePrefix: string;
  /** Network timeout for URL downloads. Default 30s. */
  fetchTimeoutMs?: number;
}): Promise<string[]> {
  const written: string[] = [];
  const collected = collectImageRefs(opts.response);
  if (collected.length === 0) return written;

  mkdirSync(opts.dir, { recursive: true });

  let idx = 0;
  for (const ref of collected) {
    const seq = collected.length === 1 ? "" : `-${idx}`;
    try {
      if (ref.kind === "b64") {
        const ext = ref.mediaType?.includes("jpeg") ? "jpg" : "png";
        const path = join(
          opts.dir,
          `${opts.basenamePrefix}${seq}.${ext}`,
        );
        writeFileSync(path, Buffer.from(ref.data, "base64"));
        written.push(path);
      } else {
        const ext = guessExtFromUrl(ref.url) ?? "png";
        const path = join(
          opts.dir,
          `${opts.basenamePrefix}${seq}.${ext}`,
        );
        const bytes = await fetchBytes(ref.url, opts.fetchTimeoutMs ?? 30_000);
        if (bytes) {
          writeFileSync(path, Buffer.from(bytes));
          written.push(path);
        }
      }
    } catch (err) {
      consola.debug(
        `[image-save] ${opts.basenamePrefix}${seq} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    idx++;
  }
  return written;
}

interface UrlRef {
  kind: "url";
  url: string;
}
interface B64Ref {
  kind: "b64";
  data: string;
  mediaType?: string;
}
type ImageRef = UrlRef | B64Ref;

/**
 * Recursively walk a parsed response body and pull out anything that looks
 * like a generated-image reference. Handles:
 *   - OpenAI:    `{ data: [{ url }] }` or `{ data: [{ b64_json }] }`
 *   - Vendor:    nested under `images`, `output`, `result`, `outputs`, etc.
 *   - Markdown:  `![](https://...)` or bare URLs in text content
 *   - Data URIs: `data:image/png;base64,...`
 */
function collectImageRefs(node: unknown, out: ImageRef[] = []): ImageRef[] {
  if (node == null) return out;
  if (typeof node === "string") {
    pushFromString(node, out);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectImageRefs(item, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    // Direct OpenAI shape
    if (typeof o.url === "string" && looksLikeImageUrl(o.url)) {
      out.push({ kind: "url", url: o.url });
    }
    if (typeof o.b64_json === "string" && o.b64_json.length > 100) {
      out.push({ kind: "b64", data: o.b64_json });
    }
    if (typeof o.image_url === "string" && looksLikeImageUrl(o.image_url)) {
      out.push({ kind: "url", url: o.image_url });
    }
    // Some providers return base64 under different keys.
    if (typeof o.image === "string" && o.image.length > 100 && /^[A-Za-z0-9+/=]+$/.test(o.image.slice(0, 100))) {
      out.push({ kind: "b64", data: o.image });
    }
    // Recurse into all object values.
    for (const v of Object.values(o)) collectImageRefs(v, out);
  }
  return out;
}

function pushFromString(s: string, out: ImageRef[]): void {
  // Data URIs
  const dataUriRe = /data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)/g;
  for (const m of s.matchAll(dataUriRe)) {
    out.push({ kind: "b64", data: m[2]!, mediaType: `image/${m[1]}` });
  }
  // Bare or markdown-wrapped image URLs. Be conservative: require a known
  // image extension or a /image/ path component to avoid pulling random
  // links from refusal text.
  const urlRe = /https?:\/\/[^\s)<>"']+/g;
  for (const m of s.matchAll(urlRe)) {
    if (looksLikeImageUrl(m[0])) out.push({ kind: "url", url: m[0] });
  }
}

function looksLikeImageUrl(url: string): boolean {
  return (
    /\.(png|jpe?g|webp|gif|bmp)(?:\?|$)/i.test(url) ||
    /\/image|\/cdn\/|\/render|\/output|\/results?\//i.test(url)
  );
}

function guessExtFromUrl(url: string): string | undefined {
  const m = url.match(/\.(png|jpe?g|webp|gif|bmp)(?:\?|$)/i);
  if (!m) return undefined;
  const ext = m[1]!.toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

async function fetchBytes(
  url: string,
  timeoutMs: number,
): Promise<ArrayBuffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
