import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { consola } from "consola";

/** A saved image plus its decoded dimensions. */
export interface SavedImage {
  path: string;
  w: number;
  h: number;
}

/** Save generated image bytes so the user can inspect output after the CDN URL expires. Download failures never fail a passing probe. */
export async function saveResponseImages(opts: {
  response: unknown;
  /** `logs/images/<provider>/<model>/` */
  dir: string;
  /** Per-attempt timestamp + channel slug used to disambiguate filenames.
   *  Final filenames embed the decoded dimensions:
   *    `${basenamePrefix}[-i]-{w}x{h}.{ext}`. */
  basenamePrefix: string;
  /** Network timeout for URL downloads. Default 30s. */
  fetchTimeoutMs?: number;
}): Promise<SavedImage[]> {
  const refs = extractRefs(opts.response);
  if (refs.length === 0) return [];

  mkdirSync(opts.dir, { recursive: true });
  const timeoutMs = opts.fetchTimeoutMs ?? 30_000;

  // Parallel saves - MJ task fetches return up to 4 quad-grid URLs and
  // sequential downloads serialize them needlessly. Each saveOne handles
  // its own errors; failures land as null in the settled array.
  const results = await Promise.all(
    refs.map(async (ref, i) => {
      const seq = refs.length === 1 ? "" : `-${i}`;
      try {
        return await saveOne(
          ref,
          opts.dir,
          opts.basenamePrefix + seq,
          timeoutMs,
        );
      } catch (err) {
        consola.debug(
          `[image-save] ${opts.basenamePrefix}${seq} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  return results.filter((p): p is SavedImage => p !== null);
}

interface ImageRef {
  kind: "url" | "b64";
  value: string;
  /** Optional explicit media type (only present for data: URIs that include it). */
  mediaType?: string;
}

// Extract from canonical OUTPUT fields only — a prior tree-walker silently
// grabbed input fixture URLs from MJ's promptEn/finalPrompt echoes.
// OpenAI: data[].url / b64_json. Videos/Replicate: poll.output. MJ: poll.imageUrl.
// Task wrapper is {submit, poll, taskId}; inspect poll only.
function extractRefs(response: unknown): ImageRef[] {
  const refs: ImageRef[] = [];
  if (response == null || typeof response !== "object") return refs;
  const root = response as Record<string, unknown>;
  // Task wrapper: only inspect poll (submit is the request we sent).
  const target =
    root.poll && typeof root.poll === "object"
      ? (root.poll as Record<string, unknown>)
      : root;

  // OpenAI image shape: data[].url / data[].b64_json
  if (Array.isArray(target.data)) {
    for (const item of target.data as unknown[]) {
      if (item == null || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.url === "string" && o.url.length > 0) {
        refs.push({ kind: "url", value: o.url });
      } else if (typeof o.b64_json === "string" && o.b64_json.length > 100) {
        refs.push({ kind: "b64", value: o.b64_json });
      }
    }
  }

  // Midjourney task fetch: imageUrl (camelCase, top-level on the poll body).
  if (typeof target.imageUrl === "string" && target.imageUrl.length > 0) {
    refs.push({ kind: "url", value: target.imageUrl });
  }
  // snake_case alt some forks return.
  if (typeof target.image_url === "string" && target.image_url.length > 0) {
    refs.push({ kind: "url", value: target.image_url });
  }

  // Replicate prediction: output is string | string[].
  const out = target.output;
  if (typeof out === "string" && out.startsWith("http")) {
    refs.push({ kind: "url", value: out });
  } else if (Array.isArray(out)) {
    for (const u of out) {
      if (typeof u === "string" && u.startsWith("http")) {
        refs.push({ kind: "url", value: u });
      }
    }
  }

  // Gemini: candidates[].content.parts[].inlineData = {mimeType|mime_type, data: <base64>}
  if (Array.isArray(target.candidates)) {
    for (const cand of target.candidates as unknown[]) {
      if (cand == null || typeof cand !== "object") continue;
      const content = (cand as Record<string, unknown>).content;
      if (content == null || typeof content !== "object") continue;
      const parts = (content as Record<string, unknown>).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts as unknown[]) {
        if (part == null || typeof part !== "object") continue;
        const inline =
          (part as Record<string, unknown>).inlineData ??
          (part as Record<string, unknown>).inline_data;
        if (inline == null || typeof inline !== "object") continue;
        const o = inline as Record<string, unknown>;
        const data = o.data;
        if (typeof data !== "string" || data.length < 100) continue;
        const mt = (o.mimeType ?? o.mime_type) as string | undefined;
        refs.push({ kind: "b64", value: data, mediaType: mt });
      }
    }
  }

  // Chat-completions wrapper (gateway-translated vendor models): choices[].message.content
  // can be string with markdown/data-URI/bare URL, or [{type, image_url|text}, ...]
  if (Array.isArray(target.choices)) {
    for (const ch of target.choices as unknown[]) {
      if (ch == null || typeof ch !== "object") continue;
      const msg = (ch as Record<string, unknown>).message;
      if (msg == null || typeof msg !== "object") continue;
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") {
        refs.push(...extractFromMarkdownOrText(content));
      } else if (Array.isArray(content)) {
        for (const part of content as unknown[]) {
          if (part == null || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          const iu = p.image_url;
          if (typeof iu === "string") {
            refs.push(...extractFromMarkdownOrText(iu));
          } else if (iu && typeof iu === "object") {
            const url = (iu as Record<string, unknown>).url;
            if (typeof url === "string") {
              refs.push(...extractFromMarkdownOrText(url));
            }
          }
          if (typeof p.text === "string") {
            refs.push(...extractFromMarkdownOrText(p.text));
          }
        }
      }
    }
  }

  return dedupe(refs);
}

/** Scoped regexes (not a tree walk) so we don't pick up echoes of input fixture URLs in the response text. */
function extractFromMarkdownOrText(text: string): ImageRef[] {
  const out: ImageRef[] = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const ref = parseRef(m[1]!);
    if (ref) out.push(ref);
  }
  for (const m of text.matchAll(
    /data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+/g,
  )) {
    const ref = parseRef(m[0]);
    if (ref) out.push(ref);
  }
  for (const m of text.matchAll(
    /https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)]*)?/gi,
  )) {
    out.push({ kind: "url", value: m[0] });
  }
  return out;
}

function parseRef(value: string): ImageRef | null {
  if (value.startsWith("data:image/")) {
    const m = value.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!m) return null;
    return { kind: "b64", value: m[2]!, mediaType: m[1] };
  }
  if (/^https?:\/\//.test(value)) {
    return { kind: "url", value };
  }
  return null;
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
): Promise<SavedImage | null> {
  let bytes: Buffer;
  let ext: string;

  if (ref.kind === "b64") {
    ext = ref.mediaType?.includes("jpeg") ? "jpg" : "png";
    bytes = Buffer.from(ref.value, "base64");
  } else {
    // Some grok-* gateways serve /file_download/<uuid> with no extension;
    // fall back to Content-Type so the saved filename is still labelled.
    const r = await fetch(ref.value, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    ext =
      guessExtFromUrl(ref.value) ??
      extFromContentType(r.headers.get("content-type")) ??
      "png";
    bytes = Buffer.from(await r.arrayBuffer());
  }
  // 0x0 fallback when format is unrecognized — informative signal in the filename.
  const dims = readImageDimensions(bytes) ?? { w: 0, h: 0 };
  const path = join(dir, `${basename}-${dims.w}x${dims.h}.${ext}`);
  writeFileSync(path, bytes);
  return { path, w: dims.w, h: dims.h };
}

function extFromContentType(ct: string | null): string | undefined {
  if (!ct) return undefined;
  const m = ct.toLowerCase().match(/image\/(png|jpeg|jpg|webp|gif|bmp)/);
  if (!m) return undefined;
  const ext = m[1]!;
  return ext === "jpeg" ? "jpg" : ext;
}

function guessExtFromUrl(url: string): string | undefined {
  const m = url.match(/\.(png|jpe?g|webp|gif|bmp)(\?|$)/i);
  if (!m) return undefined;
  const ext = m[1]!.toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/** Header-parse w/h from PNG/JPEG/WebP/GIF. null when format unknown. Shared with scripts/backfill so it avoids spawning `identify`. */
export function readImageDimensions(
  buf: Buffer,
): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  // PNG: signature 89 50 4E 47, IHDR at byte 16/20.
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a", LE w/h at 6/8.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP, then VP8 / VP8L / VP8X chunk with format-specific encoding.
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const fourcc = buf.toString("ascii", 12, 16);
    if (fourcc === "VP8 ") {
      return {
        w: buf.readUInt16LE(26) & 0x3fff,
        h: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (fourcc === "VP8L") {
      const b0 = buf[21]!,
        b1 = buf[22]!,
        b2 = buf[23]!,
        b3 = buf[24]!;
      return {
        w: 1 + (((b1 & 0x3f) << 8) | b0),
        h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (fourcc === "VP8X") {
      return {
        w: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)),
        h: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)),
      };
    }
    return null;
  }
  // JPEG: SOI (FFD8), walk segments to SOFn (FFC0..C3, C5..C7, C9..CB, CD..CF).
  // Each segment has 2-byte BE length right after the marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      while (buf[i] === 0xff) i++; // skip fill bytes
      const marker = buf[i++]!;
      if (marker === 0xd8 || marker === 0xd9) return null;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { h: buf.readUInt16BE(i + 3), w: buf.readUInt16BE(i + 5) };
      }
      const segLen = buf.readUInt16BE(i);
      i += segLen;
    }
    return null;
  }
  return null;
}
