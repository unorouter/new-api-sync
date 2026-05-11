import type { Fixtures } from "./fixtures";

// Dispatches on resolved upstream URL: most paths take the OAI shape, but
// Replicate, Midjourney, Gemini etc. need their own JSON/multipart bodies.
// Per-vendor refs: new-api/relay/channel/<vendor>/adaptor.go.
// Returns null when no vendor match → caller falls back to OAI default.

export interface BuiltBody {
  /** When `multipart` is true, value is a FormData. Otherwise it's a
   *  JSON-serialisable object. The probe submits accordingly. */
  multipart: boolean;
  body: FormData | Record<string, unknown>;
  /** Sanitised metadata to write into the artifact (don't dump fixture
   *  bytes / data URIs). */
  bodyMeta: Record<string, unknown>;
  /** Extra headers needed for this body shape (e.g. `Prefer: wait` for
   *  Replicate to make submit synchronous). Merged on top of the probe's
   *  default headers. */
  extraHeaders?: Record<string, string>;
}

export interface BuildBodyOpts {
  path: string;
  model: string;
  fixtures: Fixtures;
}

export function buildBody(opts: BuildBodyOpts): BuiltBody | null {
  const lp = opts.path.toLowerCase();
  // Bare /replicate/v1/predictions (no /models/) needs a model version UUID
  // we don't have; let discovery exclude those rather than burn the probe.
  if (lp.includes("/models/") && lp.includes("/predictions"))
    return buildReplicateBody(opts);
  if (lp.endsWith("/mj/submit/blend")) return buildMjBlendBody(opts);
  if (lp.endsWith("/mj/submit/imagine")) return buildMjImagineBody(opts);
  // Gemini & Imagen both land here; gateway translates our {contents} to :predict where needed.
  if (lp.includes(":generatecontent")) return buildGeminiBody(opts);
  return null;
}

// ─── Replicate (/replicate/v1/(models/.../)?predictions) ──────────────────
// Body: { input: { prompt, aspect_ratio, num_outputs, input_image*?, ... } }
// We pack BOTH `input_image` (single) AND `input_image_1..6` because:
//   - flux-kontext-pro/max: single `input_image`
//   - multi-image-kontext-*: numbered `input_image_1`..`input_image_2`
//   - t2i (flux-1.1-pro, recraft-v3, ideogram-v3): no image fields used
// Fields the schema doesn't list are silently dropped upstream.
// `Prefer: wait` makes the submit synchronous (no separate poll loop).

function buildReplicateBody(opts: BuildBodyOpts): BuiltBody {
  const input: Record<string, unknown> = {
    prompt: opts.fixtures.prompt,
    aspect_ratio: "1:1",
    num_outputs: 1,
  };
  if (opts.fixtures.dataUris.length > 0) {
    input.input_image = opts.fixtures.dataUris[0];
  }
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

// ─── Midjourney blend (/mj/submit/blend) ──────────────────────────────────
// 2-5 raw base64 (no data: prefix) under base64Array, then poll /mj/task/:id/fetch.

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

// ─── Midjourney imagine (/mj/submit/imagine) — prompt only, no refs ───────

function buildMjImagineBody(opts: BuildBodyOpts): BuiltBody {
  return {
    multipart: false,
    body: {
      prompt: opts.fixtures.prompt,
      botType: "MID_JOURNEY",
      notifyHook: "",
      state: "",
    },
    bodyMeta: {
      prompt: opts.fixtures.prompt,
      botType: "MID_JOURNEY",
    },
  };
}

// ─── Gemini native (/v1beta/models/{model}:generateContent) ───────────────

function buildGeminiBody(opts: BuildBodyOpts): BuiltBody {
  const parts: unknown[] = opts.fixtures.dataUris.map((u) => {
    const m = u.match(/^data:([^;]+);base64,(.+)$/);
    const mimeType = m?.[1] ?? "image/jpeg";
    const data = m?.[2] ?? u;
    return { inline_data: { mime_type: mimeType, data } };
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
