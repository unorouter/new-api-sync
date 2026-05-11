import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface SavedImage {
  path: string;
  w: number;
  h: number;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

export async function saveResponseImages(opts: {
  response: unknown;
  dir: string;
  basenamePrefix: string;
  fetchTimeoutMs?: number;
}): Promise<SavedImage[]> {
  const refs = extractRefs(opts.response);
  if (refs.length === 0) return [];
  mkdirSync(opts.dir, { recursive: true });
  const timeoutMs = opts.fetchTimeoutMs ?? 30_000;
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
      } catch {
        return null;
      }
    }),
  );
  return results.filter((p): p is SavedImage => p !== null);
}

interface ImageRef {
  kind: "url" | "b64";
  value: string;
  mediaType?: string;
}

function extractRefs(response: unknown): ImageRef[] {
  const refs: ImageRef[] = [];
  const root = asObj(response);
  if (!root) return refs;
  const target = asObj(root.poll) ?? root;

  if (Array.isArray(target.data)) {
    for (const item of target.data as unknown[]) {
      const o = asObj(item);
      if (!o) continue;
      if (typeof o.url === "string" && o.url.length > 0)
        refs.push({ kind: "url", value: o.url });
      else if (typeof o.b64_json === "string" && o.b64_json.length > 100)
        refs.push({ kind: "b64", value: o.b64_json });
    }
  }
  for (const key of ["imageUrl", "image_url"] as const) {
    const v = target[key];
    if (typeof v === "string" && v.length > 0)
      refs.push({ kind: "url", value: v });
  }
  const out = target.output;
  if (typeof out === "string" && out.startsWith("http"))
    refs.push({ kind: "url", value: out });
  else if (Array.isArray(out)) {
    for (const u of out)
      if (typeof u === "string" && u.startsWith("http"))
        refs.push({ kind: "url", value: u });
  }
  if (Array.isArray(target.candidates)) {
    for (const cand of target.candidates as unknown[]) {
      const parts = asObj(asObj(cand)?.content)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts as unknown[]) {
        const inline = asObj(
          asObj(part)?.inlineData ?? asObj(part)?.inline_data,
        );
        if (!inline) continue;
        const data = inline.data;
        if (typeof data !== "string" || data.length < 100) continue;
        refs.push({
          kind: "b64",
          value: data,
          mediaType: (inline.mimeType ?? inline.mime_type) as
            | string
            | undefined,
        });
      }
    }
  }
  if (Array.isArray(target.choices)) {
    for (const ch of target.choices as unknown[]) {
      const content = asObj(asObj(ch)?.message)?.content;
      if (typeof content === "string")
        refs.push(...extractFromMarkdownOrText(content));
      else if (Array.isArray(content)) {
        for (const part of content as unknown[]) {
          const p = asObj(part);
          if (!p) continue;
          const iu = p.image_url;
          if (typeof iu === "string")
            refs.push(...extractFromMarkdownOrText(iu));
          else {
            const url = asObj(iu)?.url;
            if (typeof url === "string")
              refs.push(...extractFromMarkdownOrText(url));
          }
          if (typeof p.text === "string")
            refs.push(...extractFromMarkdownOrText(p.text));
        }
      }
    }
  }
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = r.kind + ":" + r.value.slice(0, 200);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

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
    return m ? { kind: "b64", value: m[2]!, mediaType: m[1] } : null;
  }
  return /^https?:\/\//.test(value) ? { kind: "url", value } : null;
}

const normExt = (ext: string): string => (ext === "jpeg" ? "jpg" : ext);

async function saveOne(
  ref: ImageRef,
  dir: string,
  basename: string,
  timeoutMs: number,
): Promise<SavedImage | null> {
  let bytes: Buffer, ext: string;
  if (ref.kind === "b64") {
    ext = ref.mediaType?.includes("jpeg") ? "jpg" : "png";
    bytes = Buffer.from(ref.value, "base64");
  } else {
    const r = await fetch(ref.value, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const urlMatch = ref.value.match(/\.(png|jpe?g|webp|gif|bmp)(\?|$)/i);
    const ctMatch = r.headers
      .get("content-type")
      ?.toLowerCase()
      .match(/image\/(png|jpeg|jpg|webp|gif|bmp)/);
    ext = normExt((urlMatch?.[1] ?? ctMatch?.[1] ?? "png").toLowerCase());
    bytes = Buffer.from(await r.arrayBuffer());
  }
  const dims = readImageDimensions(bytes) ?? { w: 0, h: 0 };
  const path = join(dir, `${basename}-${dims.w}x${dims.h}.${ext}`);
  writeFileSync(path, bytes);
  return { path, w: dims.w, h: dims.h };
}

export function readImageDimensions(
  buf: Buffer,
): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
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
    if (fourcc === "VP8 ")
      return {
        w: buf.readUInt16LE(26) & 0x3fff,
        h: buf.readUInt16LE(28) & 0x3fff,
      };
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
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      while (buf[i] === 0xff) i++;
      const marker = buf[i++]!;
      if (marker === 0xd8 || marker === 0xd9) return null;
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF)
        return { h: buf.readUInt16BE(i + 3), w: buf.readUInt16BE(i + 5) };
      i += buf.readUInt16BE(i);
    }
  }
  return null;
}
