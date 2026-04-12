// Browser-safe model-type constants. Extracted from constants.ts so the web
// bundle doesn't pull in micromatch (Node-only, dynamic requires) through a
// transitive import.

export const MODEL_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "embedding",
] as const;
export type ModelType = (typeof MODEL_TYPES)[number];
