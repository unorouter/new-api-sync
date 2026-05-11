import type { Fixtures } from "./fixtures";
import { probe, isOpenAiImageOk, type ProbeAttempt } from "./probe";

export interface GenerationsProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  path?: string;
  timeoutMs?: number;
}

/** OpenAI-compatible `/v1/images/generations`: text-to-image, no refs. Useful for diffing wire-shape coverage on models that advertise both edit and generation endpoints. */
export async function probeGenerationsChannel(
  opts: GenerationsProbeOpts,
): Promise<ProbeAttempt> {
  const body = {
    model: opts.model,
    prompt: opts.fixtures.prompt,
    n: 1,
    size: "1024x1024",
  };
  return probe(
    {
      url:
        opts.baseUrl.replace(/\/$/, "") +
        (opts.path ?? "/v1/images/generations"),
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "New-Api-User": String(opts.userId),
      },
      body,
      sanitizedBody: body,
      timeoutMs: opts.timeoutMs,
    },
    isOpenAiImageOk,
  );
}
