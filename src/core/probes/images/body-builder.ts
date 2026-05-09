import type { Fixtures } from "./fixtures";

/**
 * Per-vendor body shape builder for image probes.
 *
 * Most new-api channels accept the OpenAI-canonical body shape on
 * /v1/images/edits, /v1/images/generations, /v1/chat/completions, and
 * /v1/videos. But several vendor-native paths (Replicate, Midjourney,
 * Gemini, Kling, Volcengine) require their own JSON / multipart shapes.
 *
 * This module dispatches on the resolved upstream URL path: each path
 * family has a distinct body builder. The reference for each is the
 * corresponding `relay/channel/<vendor>/adaptor.go` `ConvertImageRequest`
 * or `BuildRequestBody` in the new-api source tree.
 *
 * Out of scope: video paths (kling-video, runway, luma, veo, vidu,
 * jimeng video), MJ action ops (mj_variation, mj_action - they require
 * a prior task customId/taskId and can't be probed cold), fal-ai
 * variants (each has its own field names; would need ~30 builders).
 */

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

/**
 * Return null when the path doesn't match a known vendor shape so the
 * caller can fall back to its default body. The hardcoded probe modules
 * (probe-sync, probe-generations, probe-openai-image-edit, probe-task)
 * remain the canonical builders for the OAI-compatible paths.
 */
export function buildBody(opts: BuildBodyOpts): BuiltBody | null {
  const lp = opts.path.toLowerCase();

  // Replicate: /replicate/v1/models/{vendor}/{model}/predictions
  //
  // Bare /replicate/v1/predictions (without /models/.../) requires a
  // model version UUID in the body (`version` field). yun lists ~11
  // models on the bare path that we have no UUIDs for - return null so
  // discovery excludes them via hasAtLeastOneHandledEndpoint, rather
  // than burning a probe on a guaranteed "model or version is required"
  // 4xx.
  if (lp.includes("/models/") && lp.includes("/predictions")) {
    return buildReplicateBody(opts);
  }
  // Midjourney blend: 6 base64 images + dimensions + botType.
  if (lp.endsWith("/mj/submit/blend")) {
    return buildMjBlendBody(opts);
  }
  // Midjourney imagine: prompt-only, no refs. Useful only as a sanity
  // probe - this isn't an edit endpoint and won't compose 6 chars.
  if (lp.endsWith("/mj/submit/imagine")) {
    return buildMjImagineBody(opts);
  }
  // Gemini-native multimodal generation. Imagen-* on :generateContent
  // also lands here: the gateway is responsible for translating our
  // {contents} body to Imagen's :predict shape on the upstream side.
  if (lp.includes(":generatecontent")) {
    return buildGeminiBody(opts);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Replicate (`/replicate/v1/(models/.../)?predictions`)
// ---------------------------------------------------------------------------
//
// Reference: new-api/relay/channel/replicate/adaptor.go ConvertImageRequest.
// Body: { input: { prompt, image_prompt?, aspect_ratio, num_outputs } }.
// Headers: Prefer: wait makes submit synchronous (avoids polling the
// Replicate task path - the gateway returns the prediction inline).

function buildReplicateBody(opts: BuildBodyOpts): BuiltBody {
  // Replicate's multi-image inputs vary by model. Verified against yun's
  // docs (the only public reference for the gateway-side schema):
  //   - black-forest-labs/flux-kontext-pro / flux-kontext-max single-image
  //     edit takes `input_image` (singular).
  //   - flux-kontext-apps/multi-image-kontext-{pro,max} take `input_image_1`,
  //     `input_image_2` (only 2; extras ignored).
  //   - Generation-only models (flux-1.1-pro, flux-schnell, recraft-v3,
  //     ideogram-v3) accept the same `input` envelope without image fields.
  //
  // We pack BOTH `input_image` (single, first ref) AND `input_image_1..6`
  // so single-ref edit models AND multi-ref edit models both pick up
  // what they need; fields the schema doesn't list are silently
  // dropped. Pure t2i models ignore the image fields entirely.
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
    // Synchronous wait: returns 200 with the result payload instead of a
    // 202 + task_id requiring a poll loop. Mirrors what the new-api
    // Replicate adapter sets at adaptor.go line 58.
    extraHeaders: { Prefer: "wait" },
  };
}

// ---------------------------------------------------------------------------
// Midjourney blend (`/mj/submit/blend`)
// ---------------------------------------------------------------------------
//
// Reference: new-api/dto/midjourney.go MidjourneyRequest. The `blend`
// endpoint takes a list of 2-5 base64 images (NO data: prefix) under
// `base64Array`, plus `dimensions` and `botType`. Returns a task that
// must be polled at /mj/task/:id/fetch.

function buildMjBlendBody(opts: BuildBodyOpts): BuiltBody {
  // Strip the `data:image/jpeg;base64,` prefix - MJ wants raw base64.
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

// ---------------------------------------------------------------------------
// Midjourney imagine (`/mj/submit/imagine`)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Gemini native (`/v1beta/models/{model}:generateContent`)
// ---------------------------------------------------------------------------
//
// Reference: Gemini API docs. Image inputs are inline_data parts with
// mime_type + base64. Text is a separate part. The whole goes under
// contents[0].parts[].

function buildGeminiBody(opts: BuildBodyOpts): BuiltBody {
  const parts: unknown[] = opts.fixtures.dataUris.map((u) => {
    // Strip the `data:image/jpeg;base64,` prefix and split mime/data.
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

