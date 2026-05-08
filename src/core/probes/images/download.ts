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
 * Vendor-aware extraction: pull image URLs ONLY from canonical output
 * fields. The earlier version walked the entire response tree and
 * extracted any URL it found in any string - which silently grabbed
 * INPUT fixture URLs from MJ's `promptEn` / `properties.finalPrompt`
 * echo fields, polluting the saved files.
 *
 * Per-vendor canonical output fields:
 *   - OpenAI image shape:    response.data[].url, response.data[].b64_json
 *   - OpenAI Videos task:    response.poll.output / .data.url / .urls
 *   - Replicate prediction:  response.poll.output (string or string[])
 *   - Midjourney task fetch: response.poll.imageUrl (camelCase)
 *
 * For task probes, the orchestrator passes the COMPOSITE response
 * `{submit, poll, taskId}` so we look inside `poll` first.
 */
function extractRefs(response: unknown): ImageRef[] {
  const refs: ImageRef[] = [];
  if (response == null || typeof response !== "object") return refs;
  const root = response as Record<string, unknown>;

  // Task-probe wrapper: {submit, poll, taskId}. Only inspect poll - the
  // submit body is the request shape we sent and never holds the output.
  const target = (root.poll && typeof root.poll === "object")
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

  // Gemini-native shape: candidates[].content.parts[].inlineData.
  // Each inlineData is `{mimeType: "image/png", data: "<raw-base64>"}`
  // (camelCase) or `{mime_type, data}` (snake_case, some forks).
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

  // Chat-completions shape: choices[].message.content. Used by gateways that
  // wrap vendor-native image models (Gemini image-preview, Doubao Seedream,
  // Qwen-Image-Edit, etc.) behind /v1/chat/completions. Content can be:
  //   - a string with embedded `![alt](data:image/...;base64,XXX)` markdown,
  //   - a string with a bare `data:image/...;base64,XXX` URI,
  //   - a string with a bare https URL ending in an image extension,
  //   - an array of parts `[{type:"image_url", image_url:{url}}, ...]`.
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

/**
 * Pull image refs out of a chat-completions text payload. Handles markdown
 * `![alt](data:...|https://...)`, bare data: URIs, and bare https URLs that
 * look like an image. We use scoped regexes (not a recursive walk) so we
 * never pick up upstream echoes of our own input fixtures - the response
 * text is the model's OUTPUT message and any URI/URL there is its product.
 */
function extractFromMarkdownOrText(text: string): ImageRef[] {
  const out: ImageRef[] = [];
  // Markdown image: ![alt](url-or-data-uri). Capture the URL inside ().
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const m of text.matchAll(mdRe)) {
    const inner = m[1]!;
    const ref = parseRef(inner);
    if (ref) out.push(ref);
  }
  // Bare data: URI not already inside markdown parens. Match conservatively
  // up to whitespace or quote so we don't grab trailing JSON characters.
  const dataRe = /data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+/g;
  for (const m of text.matchAll(dataRe)) {
    const ref = parseRef(m[0]);
    if (ref) out.push(ref);
  }
  // Bare https://...png|jpg|webp|gif (with optional query). Match up to
  // whitespace or quote to avoid greedy capture.
  const urlRe = /https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)]*)?/gi;
  for (const m of text.matchAll(urlRe)) {
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
