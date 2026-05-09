import { configDir } from "@core/config";
import { join } from "path";

/**
 * Reference fixtures bundled in `<repo>/images/`. Six photographs that
 * mimic Matic's RP scene structure: 1 real-photo location (CC0 PxHere
 * empty diner) + 5 photorealistic character portraits at 1024x1024.
 *
 * They are loaded once at probe start and reused for every (provider,
 * model, channel) attempt so results stay comparable. All ≥384px on each
 * side so models with strict-dimension validators (wan2.5-i2i-preview)
 * accept them.
 *
 * License + provenance details are in `images/README.md`.
 */
export const FIXTURE_FILENAMES = [
  "0.jpg",
  "1.webp",
  "2.webp",
  "3.webp",
  "4.webp",
  "5.webp",
] as const;

/**
 * Single instruction submitted alongside every probe, regardless of probe
 * kind. Matches Matic's actual workload: place 5 characters in a real
 * setting and emit one composed scene. Centralising this here means
 * sync, openai-vendor, and task probes all submit the identical 6 images
 * + identical text — results stay directly comparable across channels
 * and prompt A/B testing later is trivial.
 */
export const FIXTURE_PROMPT =
  "Compose a single photorealistic group photograph placing the five " +
  "people from images 1-5 inside the diner shown in image 0. Image 1 " +
  "is the smiling man with brown hair and a dark shirt, image 2 is the " +
  "blonde woman in the floral dress, image 3 is the woman with " +
  "burgundy-streaked dark hair and tattoos, image 4 is the red-haired " +
  "young woman with glasses and a green sweater, image 5 is the " +
  "smiling brunette woman in a green crop top. Seat or stand them " +
  "together at the diner booth. Preserve each person's distinctive " +
  "appearance. Single output image.";

export interface Fixtures {
  /** Files in fixed order [bg, user, npc1, npc2, npc3, npc4]. */
  files: File[];
  /** data:image/jpeg;base64,... per file, parallel to `files`. */
  dataUris: string[];
  /** Total bytes — for cost / payload-size logging. */
  totalBytes: number;
  /** Shared prompt all probes attach to the request. */
  prompt: string;
}

/**
 * Return a derived `Fixtures` carrying only the first N image refs. Prompt
 * and bytes total are preserved (text isn't affected by ref-count). Used by
 * the orchestrator's image-count downshift: when an upstream rejects 6 refs
 * with `"supports 0~3 image content items. Got 6"`, we re-run the same
 * (shape, path) with N=max so the model can actually run instead of the
 * probe burning a guaranteed 4xx.
 *
 * N is clamped to [0, current.dataUris.length] so callers can't accidentally
 * grow the fixture.
 */
export function withFixtureCount(base: Fixtures, n: number): Fixtures {
  const clamped = Math.max(0, Math.min(n, base.files.length));
  if (clamped === base.files.length) return base;
  return {
    files: base.files.slice(0, clamped),
    dataUris: base.dataUris.slice(0, clamped),
    totalBytes: base.totalBytes, // metadata-only; no need to recompute
    prompt: base.prompt,
  };
}

let cached: Fixtures | undefined;

/**
 * Read the fixtures from `<configDir>/images/` once and return
 * synchronously-reusable buffers. MIME type is inferred from the file
 * extension (.jpg/.jpeg → image/jpeg, .webp → image/webp, .png → image/png).
 * Throws if any file is missing — failing loud is the right call because
 * every probe depends on having all of them.
 */
export async function loadFixtures(): Promise<Fixtures> {
  if (cached) return cached;
  const dir = join(configDir(), "images");
  const files: File[] = [];
  const dataUris: string[] = [];
  let totalBytes = 0;
  for (const name of FIXTURE_FILENAMES) {
    const path = join(dir, name);
    const bun = Bun.file(path);
    if (!(await bun.exists())) {
      throw new Error(
        `Image fixture missing: ${path}. Run the README refresh procedure to redownload it.`,
      );
    }
    const buf = await bun.arrayBuffer();
    totalBytes += buf.byteLength;
    const mime = mimeFromName(name);
    files.push(new File([buf], name, { type: mime }));
    const b64 = Buffer.from(buf).toString("base64");
    dataUris.push(`data:${mime};base64,${b64}`);
  }
  cached = { files, dataUris, totalBytes, prompt: FIXTURE_PROMPT };
  return cached;
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}
