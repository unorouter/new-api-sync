/**
 * Resolve a model slug into a canonical-name + display-name pair so that
 * `recraftv3`, `recraft-ai/recraft-v3`, `recraft-v3`, and `Recraft-V3`
 * collapse to a single canonical key. Discovery returns one Candidate per
 * pricing entry; the orchestrator dedupes by canonical name within a
 * provider so we don't probe the same upstream twice and burn budget on
 * variants of the same model.
 *
 * The canonical name is NOT the name we send to upstream — that stays the
 * raw `model` string from pricing. This is purely a dedup key + dry-run
 * label.
 */

/**
 * Return both the canonical key (lowercase, dash-joined, vendor-prefix
 * stripped) and the original name. Two slugs that share a canonical key
 * are treated as the same upstream model.
 *
 * Examples:
 *   recraftv3                       -> recraft-v3
 *   recraft-ai/recraft-v3           -> recraft-v3
 *   recraft-v3                      -> recraft-v3
 *   ideogram-ai/ideogram-v3-quality -> ideogram-v3-quality
 *   ideogram_generate_V_3_QUALITY   -> ideogram-v3-quality
 *   fal-ai/recraft/v3/text-to-image -> recraft-v3
 *   fal-ai/luma-dream-machine/ray-2 -> luma-ray-2
 *   gpt-image-2-2026-04-21          -> gpt-image-2
 *   gpt-image-2-vip                 -> gpt-image-2
 *   wan2.6-r2v-flash_1080P_true     -> wan2.6-r2v-flash
 *   Pro/black-forest-labs/FLUX.1-schnell -> flux-schnell
 */
export function canonicalize(rawName: string): string {
  let s = rawName.toLowerCase().trim();

  // 1. Strip well-known org/vendor prefixes that namespace the same upstream.
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

  // 2. fal-ai paths use slashes as a hierarchy: <vendor>/<model>/<task>.
  //    Drop the trailing /text-to-image, /image-to-image, /image-to-video
  //    so different submission modes of the same model collapse.
  s = s.replace(/\/(text-to-image|image-to-image|image-to-video|text-to-video|reference-to-video|image-to-3d)$/i, "");

  // 3. Replace remaining slashes / underscores with dashes. ideogram_generate_V_3_QUALITY
  //    becomes ideogram-generate-v-3-quality, then patterns below normalize it.
  s = s.replace(/[\/_]/g, "-");

  // 4. Vendor-prefixed slugs like "recraft-ai-recraft-v3" -> drop the duplicate prefix.
  s = s.replace(/^([a-z]+)-ai-\1-/, "$1-");

  // 5. ideogram-style "ideogram-generate-v-3-quality" / "ideogram-generate-V_3_DEFAULT"
  //    collapse to "ideogram-v3-<tier>". Strip the "generate", "edit", etc.
  //    verb tokens; keep the version + tier.
  if (s.startsWith("ideogram-")) {
    s = s
      .replace(/-?(generate|remix|edit|reframe|replace-background|describe|upscale)-/g, "-")
      .replace(/-v-(\d+)-/, "-v$1-")  // -v-3- -> -v3-
      .replace(/-+/g, "-");
  }

  // 6. recraftv3 -> recraft-v3 (insert dash before version number)
  s = s.replace(/^([a-z]+)(v\d+(?:\.\d+)?)/, "$1-$2");

  // 7. Strip date stamps (YYYY-MM-DD or YY-MM-DD or YYYYMMDD anywhere)
  s = s.replace(/-\d{4}-\d{2}-\d{2}\b/g, "");
  s = s.replace(/-\d{8}\b/g, "");
  s = s.replace(/-\d{6}\b/g, "");

  // 8. Strip tier / quota suffixes that the same upstream slaps onto
  //    multiple SKUs at the gateway level (e.g. -all, -vip, -free, -test,
  //    -token). These are billing tiers, not different models.
  s = s.replace(/-(all|vip|free|test|token|business|c|codex|coding|web|ssvip|preview)$/g, "");
  s = s.replace(/-(all|vip|free|test|token|business|c|codex|coding|web|ssvip|preview)-/g, "-");

  // 9. Strip resolution / dimension / boolean preset suffixes that probe
  //    distinct sizes of the same model.
  s = s.replace(/-(\d+)p-?(true|false)?$/g, "");        // -1080p, -1080p-true
  s = s.replace(/-(\d+)x(\d+)$/g, "");                  // -1024x1024
  s = s.replace(/-?_(\d+)\*(\d+)(_(true|false))?$/g, ""); // _1920*1080_true
  s = s.replace(/-?_(\d+)P(_(true|false))?$/g, "");     // _720P_true
  s = s.replace(/-(\d+)(p|k)-(\d+)s$/g, "");            // -1080p-4s
  s = s.replace(/-(\d+)(p|k)$/g, "");                   // -2k, -4k, -1080p
  s = s.replace(/-(true|false)$/g, "");

  // 10. Normalize version separators: `3-5` <-> `3.5` and `flux.1` <-> `flux-1`.
  //     Pricing entries use both interchangeably; collapse to dotted form.
  s = s.replace(/(\d)-(\d)(?=-|$)/g, "$1.$2");
  s = s.replace(/^([a-z]+)\.(\d)/, "$1-$2"); // flux.1 -> flux-1 in the leading word

  // 11. Drop `dream-machine` from luma slugs so fal-ai/luma-dream-machine/ray-2
  //     and `luma-ray-2` collapse together.
  s = s.replace(/^luma-dream-machine-/, "luma-");

  // 12. Collapse multiple dashes left over.
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");

  return s;
}

/**
 * Pick the "best" representative when several pricing entries map to the
 * same canonical key. Prefers entries that look like the cleanest /
 * stablest channel: shortest name wins (heuristic that filters out the
 * date-stamped / -all / -vip / dimension-suffixed variants when the bare
 * name is also present).
 */
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
