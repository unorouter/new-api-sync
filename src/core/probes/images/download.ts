import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { consola } from "consola";

/**
 * Save the actual generated image bytes from a probe response so the user
 * can eyeball the output later. Without this, only the JSON response (which
 * carries either a soon-to-expire CDN URL or a base64 blob) lands on disk -
 * and CDN URLs go stale within hours, leaving no way to qualitatively
 * compare models after the fact.
 *
 * Strategy mirrors what the unorouter app does for chat-side image
 * generation (`src/server/chat/stream.service.ts`): the canonical OpenAI
 * image shape is `{ data: [{ url? , b64_json? }] }`. We try that shape
 * first, then fall back to a recursive sweep for the long tail of vendor
 * variants (Doubao Seedream, Qwen Image Edit, MJ etc. all return slightly
 * different bodies through new-api translation).
 *
 * Returns absolute paths of files written. Failures are logged at debug
 * level and otherwise swallowed - we never want a download problem to
 * fail an otherwise-passing probe.
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
  const refs = extractRefs(opts.response);
  if (refs.length === 0) return [];

  mkdirSync(opts.dir, { recursive: true });
  const written: string[] = [];

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    const seq = refs.length === 1 ? "" : `-${i}`;
    try {
      const path = await saveOne(ref, opts.dir, opts.basenamePrefix + seq, opts.fetchTimeoutMs ?? 30_000);
      if (path) written.push(path);
    } catch (err) {
      consola.debug(
        `[image-save] ${opts.basenamePrefix}${seq} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return written;
}

interface ImageRef {
  kind: "url" | "b64";
  value: string;
  /** Optional explicit media type (only present for data: URIs that include it). */
  mediaType?: string;
}

/**
 * Try the canonical OpenAI shape first (`data: [{ url, b64_json }]`),
 * then sweep the entire response tree for stragglers. Vendors like Kling,
 * MJ, and Wan often nest the URL under different keys (`output[]`,
 * `images[]`, `result.urls[]`, etc.); the recursive sweep catches those
 * without an exhaustive vendor-shape table.
 */
function extractRefs(response: unknown): ImageRef[] {
  const refs: ImageRef[] = [];
  // Canonical OpenAI shape: data[].url / data[].b64_json
  if (
    response != null &&
    typeof response === "object" &&
    Array.isArray((response as { data?: unknown }).data)
  ) {
    for (const item of (response as { data: unknown[] }).data) {
      if (item == null || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.url === "string" && o.url.length > 0) {
        refs.push({ kind: "url", value: o.url });
      } else if (typeof o.b64_json === "string" && o.b64_json.length > 100) {
        refs.push({ kind: "b64", value: o.b64_json });
      }
    }
  }
  if (refs.length > 0) return refs;
  // Fallback: walk everything looking for image-shaped values.
  walk(response, refs);
  return dedupe(refs);
}

function walk(node: unknown, out: ImageRef[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    // data:image/...;base64,... embedded in text
    for (const m of node.matchAll(
      /data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)/g,
    )) {
      out.push({ kind: "b64", value: m[2]!, mediaType: `image/${m[1]}` });
    }
    // bare/markdown image URLs - require a known image extension or
    // CDN/render path component to avoid grabbing random links from
    // refusal text or doc URLs.
    for (const m of node.matchAll(/https?:\/\/[^\s)<>"']+/g)) {
      if (looksLikeImageUrl(m[0])) out.push({ kind: "url", value: m[0] });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.url === "string" && looksLikeImageUrl(o.url)) {
      out.push({ kind: "url", value: o.url });
    }
    if (typeof o.image_url === "string" && looksLikeImageUrl(o.image_url)) {
      out.push({ kind: "url", value: o.image_url });
    }
    if (typeof o.b64_json === "string" && o.b64_json.length > 100) {
      out.push({ kind: "b64", value: o.b64_json });
    }
    if (
      typeof o.image === "string" &&
      o.image.length > 100 &&
      /^[A-Za-z0-9+/=]+$/.test(o.image.slice(0, 100))
    ) {
      out.push({ kind: "b64", value: o.image });
    }
    for (const v of Object.values(o)) walk(v, out);
  }
}

function looksLikeImageUrl(url: string): boolean {
  return (
    /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(url) ||
    /\/(image|cdn|render|output|results?)\b/i.test(url)
  );
}

function dedupe(refs: ImageRef[]): ImageRef[] {
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const r of refs) {
    const k = r.kind + ":" + r.value.slice(0, 200);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

async function saveOne(
  ref: ImageRef,
  dir: string,
  basename: string,
  timeoutMs: number,
): Promise<string | null> {
  if (ref.kind === "b64") {
    const ext = ref.mediaType?.includes("jpeg") ? "jpg" : "png";
    const path = join(dir, `${basename}.${ext}`);
    writeFileSync(path, Buffer.from(ref.value, "base64"));
    return path;
  }
  // URL: fetch and write whatever bytes the upstream gave us.
  const ext = guessExtFromUrl(ref.value) ?? "png";
  const path = join(dir, `${basename}.${ext}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ref.value, { signal: ctrl.signal });
    if (!r.ok) return null;
    const bytes = await r.arrayBuffer();
    writeFileSync(path, Buffer.from(bytes));
    return path;
  } finally {
    clearTimeout(timer);
  }
}

function guessExtFromUrl(url: string): string | undefined {
  const m = url.match(/\.(png|jpe?g|webp|gif|bmp)(\?|$)/i);
  if (!m) return undefined;
  const ext = m[1]!.toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}
