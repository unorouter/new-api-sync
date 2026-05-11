import type { Fixtures } from "./fixtures";

export interface BuiltBody {
  multipart: boolean;
  body: FormData | Record<string, unknown>;
  bodyMeta: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

export interface BuildBodyOpts {
  path: string;
  model: string;
  fixtures: Fixtures;
}

export function buildBody(opts: BuildBodyOpts): BuiltBody | null {
  const lp = opts.path.toLowerCase();
  if (lp.includes("/models/") && lp.includes("/predictions"))
    return buildReplicateBody(opts);
  if (lp.endsWith("/mj/submit/blend")) return buildMjBlendBody(opts);
  if (lp.endsWith("/mj/submit/imagine")) return buildMjImagineBody(opts);
  if (lp.includes(":generatecontent")) return buildGeminiBody(opts);
  return null;
}

function buildReplicateBody(opts: BuildBodyOpts): BuiltBody {
  const input: Record<string, unknown> = {
    prompt: opts.fixtures.prompt,
    aspect_ratio: "1:1",
    num_outputs: 1,
  };
  if (opts.fixtures.dataUris.length > 0)
    input.input_image = opts.fixtures.dataUris[0];
  for (let i = 0; i < opts.fixtures.dataUris.length; i++) {
    input[`input_image_${i + 1}`] = opts.fixtures.dataUris[i];
  }
  return {
    multipart: false,
    body: { input },
    bodyMeta: {
      input: {
        prompt: opts.fixtures.prompt,
        aspect_ratio: "1:1",
        num_outputs: 1,
        input_image: "[DATA_URI_REDACTED]",
        input_image_1to6: "[DATA_URIS_REDACTED]",
      },
    },
    extraHeaders: { Prefer: "wait" },
  };
}

function buildMjBlendBody(opts: BuildBodyOpts): BuiltBody {
  const base64Array = opts.fixtures.dataUris.slice(0, 5).map((u) => {
    const idx = u.indexOf("base64,");
    return idx >= 0 ? u.slice(idx + 7) : u;
  });
  return {
    multipart: false,
    body: {
      base64Array,
      dimensions: "SQUARE",
      botType: "MID_JOURNEY",
      notifyHook: "",
      state: "",
    },
    bodyMeta: {
      base64Array: `[${base64Array.length} BASE64_REDACTED entries]`,
      dimensions: "SQUARE",
      botType: "MID_JOURNEY",
    },
  };
}

function buildMjImagineBody(opts: BuildBodyOpts): BuiltBody {
  return {
    multipart: false,
    body: {
      prompt: opts.fixtures.prompt,
      botType: "MID_JOURNEY",
      notifyHook: "",
      state: "",
    },
    bodyMeta: { prompt: opts.fixtures.prompt, botType: "MID_JOURNEY" },
  };
}

function buildGeminiBody(opts: BuildBodyOpts): BuiltBody {
  const parts: unknown[] = opts.fixtures.dataUris.map((u) => {
    const m = u.match(/^data:([^;]+);base64,(.+)$/);
    return {
      inline_data: { mime_type: m?.[1] ?? "image/jpeg", data: m?.[2] ?? u },
    };
  });
  parts.push({ text: opts.fixtures.prompt });
  return {
    multipart: false,
    body: {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    },
    bodyMeta: {
      contents: [
        {
          role: "user",
          parts: [
            `[${opts.fixtures.dataUris.length} INLINE_DATA_REDACTED parts]`,
            { text: opts.fixtures.prompt },
          ],
        },
      ],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    },
  };
}
