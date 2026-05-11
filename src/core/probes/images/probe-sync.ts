import type { Fixtures } from "./fixtures";
import { probe, isOpenAiImageOk, type ProbeAttempt } from "./probe";

export type { ProbeAttempt } from "./probe";

export interface SyncProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  path?: string;
  timeoutMs?: number;
}

/** OpenAI-compatible `/v1/images/edits`: 6 fixture JPEGs as `image[]` form fields + shared prompt. */
export async function probeSyncChannel(
  opts: SyncProbeOpts,
): Promise<ProbeAttempt> {
  const fd = new FormData();
  fd.set("model", opts.model);
  fd.set("prompt", opts.fixtures.prompt);
  fd.set("n", "1");
  fd.set("size", "1024x1024");
  for (const file of opts.fixtures.files) fd.append("image[]", file, file.name);

  return probe(
    {
      url: opts.baseUrl.replace(/\/$/, "") + (opts.path ?? "/v1/images/edits"),
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "New-Api-User": String(opts.userId),
      },
      body: fd,
      sanitizedBody: {
        model: opts.model,
        prompt: opts.fixtures.prompt,
        n: 1,
        size: "1024x1024",
        fixtures: opts.fixtures.files.map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type,
        })),
      },
      timeoutMs: opts.timeoutMs,
    },
    isOpenAiImageOk,
  );
}
