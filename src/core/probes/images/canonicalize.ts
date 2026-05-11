/**
 * Slug-collapse within one provider. Tiered suffixes (-all, -vip, -c, -codex,
 * -pro, -mini) stay — different code paths deserve independent results.
 *   recraftv3                            → recraft-v3
 *   ideogram_generate_V_3_QUALITY        → ideogram-v3-quality
 *   fal-ai/luma-dream-machine/ray-2      → luma-ray-2
 *   gpt-image-2-2026-04-21               → gpt-image-2
 *   Pro/black-forest-labs/FLUX.1-schnell → flux-schnell
 */
export function canonicalize(rawName: string): string {
  let s = rawName.toLowerCase().trim();

  // Org prefixes that namespace the same upstream.
  s = s.replace(/^pro\//, "");
  s = s.replace(/^fal-ai\//, "");
  s = s.replace(/^recraft-ai\//, "");
  s = s.replace(/^ideogram-ai\//, "");
  s = s.replace(/^stability-ai\//, "");
  s = s.replace(/^bytedance-seed\//, "");
  s = s.replace(/^bytedance\//, "");
  s = s.replace(/^black-forest-labs\//, "");
  s = s.replace(/^google\//, "");
  s = s.replace(/^anthropic\//, "");
  s = s.replace(/^openai\//, "");
  s = s.replace(/^qwen\//, "");
  s = s.replace(/^tencent\//, "");
  s = s.replace(/^minimaxai\//, "");
  s = s.replace(/^pruna\//, "");

  // fal-ai: drop trailing task (submission mode, not identity).
  s = s.replace(
    /\/(text-to-image|image-to-image|image-to-video|text-to-video|reference-to-video|image-to-3d)$/i,
    "",
  );

  s = s.replace(/[\/_]/g, "-");

  // recraft-ai-recraft-v3 → recraft-v3
  s = s.replace(/^([a-z]+)-ai-\1-/, "$1-");

  // Ideogram: collapse verb tokens + -v-N- → -vN-.
  if (s.startsWith("ideogram-")) {
    s = s
      .replace(
        /-?(generate|remix|edit|reframe|replace-background|describe|upscale)-/g,
        "-",
      )
      .replace(/-v-(\d+)-/, "-v$1-")
      .replace(/-+/g, "-");
  }

  // recraftv3 → recraft-v3
  s = s.replace(/^([a-z]+)(v\d+(?:\.\d+)?)/, "$1-$2");

  s = s.replace(/-\d{4}-\d{2}-\d{2}\b/g, "");
  s = s.replace(/-\d{8}\b/g, "");
  s = s.replace(/-\d{6}\b/g, "");

  // Iterative — -1080p-true takes two passes. Whitelist only; tiered suffixes stay.
  const COSMETIC_SUFFIX = /-preview$/g;
  const DIM_RES = [
    /-(\d+)p-?(true|false)?$/g,
    /-(\d+)x(\d+)$/g,
    /-?_(\d+)\*(\d+)(_(true|false))?$/g,
    /-?_(\d+)P(_(true|false))?$/g,
    /-(\d+)(p|k)-(\d+)s$/g,
    /-(\d+)(p|k)$/g,
    /-(\d+)px$/g,
    /-0\.\d+k$/g,
    /-(true|false)$/g,
    /-(audio|mute)$/g,
    /-(ref|noref)$/g,
  ];
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(COSMETIC_SUFFIX, "");
    for (const re of DIM_RES) s = s.replace(re, "");
  }

  // 3-5 ↔ 3.5; flux.1 ↔ flux-1.
  s = s.replace(/(\d)-(\d)(?=-|$)/g, "$1.$2");
  s = s.replace(/^([a-z]+)\.(\d)/, "$1-$2");

  s = s.replace(/^luma-dream-machine-/, "luma-");

  return s.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Shortest name wins. */
export function pickRepresentative<T extends { modelName: string }>(
  entries: T[],
): T {
  if (entries.length === 1) return entries[0]!;
  return [...entries].sort((a, b) => {
    const la = a.modelName.length;
    const lb = b.modelName.length;
    if (la !== lb) return la - lb;
    return a.modelName.localeCompare(b.modelName);
  })[0]!;
}
