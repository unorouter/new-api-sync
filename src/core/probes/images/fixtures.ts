import { configDir } from "@core/config";
import { join } from "path";

// prettier-ignore
export const FIXTURE_FILENAMES = ["0.jpg","1.webp","2.webp","3.webp","4.webp","5.webp"] as const;

/** Sent verbatim by every probe shape so results stay directly comparable. */
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
  /** [bg, user, npc1, npc2, npc3, npc4] */
  files: File[];
  /** data:image/jpeg;base64,... parallel to files */
  dataUris: string[];
  totalBytes: number;
  prompt: string;
}

/** Trim to first N refs for image-count downshift retries. N is clamped to [0, length]. */
export function withFixtureCount(base: Fixtures, n: number): Fixtures {
  const clamped = Math.max(0, Math.min(n, base.files.length));
  if (clamped === base.files.length) return base;
  return {
    files: base.files.slice(0, clamped),
    dataUris: base.dataUris.slice(0, clamped),
    totalBytes: base.totalBytes,
    prompt: base.prompt,
  };
}

let cached: Fixtures | undefined;

/** Throws if any fixture is missing — every probe depends on all 6. */
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
