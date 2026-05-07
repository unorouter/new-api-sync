import { configDir } from "@core/config";
import { join } from "path";

/**
 * Reference fixtures bundled in `<repo>/images/`. Six SFW JPEGs that mimic
 * Matic's RP scene structure: 1 background + 1 user character + 4 NPC sprites.
 * They are loaded once at probe start and reused for every (provider, model,
 * channel) attempt so results stay comparable.
 *
 * License + provenance details are in `images/README.md`.
 */
export const FIXTURE_FILENAMES = [
  "00-bg-room.jpg",
  "01-user-girl.jpg",
  "02-npc-warrior.jpg",
  "03-npc-mage.jpg",
  "04-npc-rogue.jpg",
  "05-npc-merchant.jpg",
] as const;

/**
 * Single instruction submitted alongside every probe, regardless of probe
 * kind. Matches Matic's actual workload: place the user character in the
 * room with the four NPCs and emit one composed scene. Centralising this
 * here means sync, openai-vendor, and task probes all submit the identical
 * 6 images + identical text — results stay directly comparable across
 * channels and prompt A/B testing later is trivial.
 */
export const FIXTURE_PROMPT =
  "Compose a single illustration combining the six reference images: place " +
  "the user character (image 01) in the room (image 00) interacting with the " +
  "four NPC characters (images 02-05). Single output image.";

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

let cached: Fixtures | undefined;

/**
 * Read the 6 fixture JPEGs from `<configDir>/images/` once and return
 * synchronously-reusable buffers. Throws if any file is missing — failing
 * loud is the right call because every probe depends on having all six.
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
    files.push(new File([buf], name, { type: "image/jpeg" }));
    const b64 = Buffer.from(buf).toString("base64");
    dataUris.push(`data:image/jpeg;base64,${b64}`);
  }
  cached = { files, dataUris, totalBytes, prompt: FIXTURE_PROMPT };
  return cached;
}
