import { buildReverseMapping } from "@core/catalog/constants/patterns";
import { tryFetchJson } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import removeMd from "remove-markdown";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const BASELLM_MODELS_URL =
  "https://basellm.github.io/llm-metadata/api/newapi/models.json";

/** Auto-generated basellm description, not useful. */
const TEMPLATE_DESCRIPTION_RE = /^.+ is an AI model provided by .+\.$/;

function stripMarkdown(text: string): string {
  return removeMd(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface OpenRouterModel {
  id: string;
  description: string;
}

export interface BasellmEntry {
  model_name: string;
  description?: string;
  /** "Reasoning,Tools,Files,Vision,128K" */
  tags?: string;
  ratio_model: number;
  ratio_completion: number;
  ratio_cache?: number;
  vendor_name?: string;
  endpoints?: string | null;
  price_per_m_input?: number;
  price_per_m_output?: number;
  price_per_m_cache_read?: number;
  price_per_m_cache_write?: number;
}

type BasellmResponse =
  | BasellmEntry[]
  | { success: boolean; data: BasellmEntry[] };

export interface ModelMetadata {
  description?: string;
  tags?: string;
}

// ─── Fetchers ────────────────────────────────────────────────────────────

/** bare model name → description. */
export async function fetchOpenRouterDescriptions(): Promise<
  Map<string, string>
> {
  const raw = await tryFetchJson<{ data: OpenRouterModel[] }>(
    OPENROUTER_MODELS_URL,
    { timeoutMs: 15_000 },
  );
  const map = new Map<string, string>();
  if (!raw?.data || !Array.isArray(raw.data)) {
    consola.warn(t("CORE.METADATA.OPENROUTER_FETCH_FAILED"));
    return map;
  }

  for (const model of raw.data) {
    if (!model.id || !model.description) continue;
    const slashIdx = model.id.indexOf("/");
    const bareName = slashIdx >= 0 ? model.id.slice(slashIdx + 1) : model.id;
    if (!map.has(bareName)) map.set(bareName, stripMarkdown(model.description));
  }

  consola.info(t("CORE.METADATA.OPENROUTER_FETCHED", { count: map.size }));
  return map;
}

/** Reused for both ratios and metadata. */
export async function fetchBasellmEntries(): Promise<BasellmEntry[]> {
  const raw = await tryFetchJson<BasellmResponse>(BASELLM_MODELS_URL, {
    timeoutMs: 15_000,
  });
  if (!raw) {
    consola.warn(t("CORE.METADATA.BASELLM_FETCH_FAILED"));
    return [];
  }
  const entries = Array.isArray(raw) ? raw : raw.data;
  if (!Array.isArray(entries)) return [];
  consola.info(t("CORE.METADATA.BASELLM_FETCHED", { count: entries.length }));
  return entries;
}

// ─── Fuzzy matching ──────────────────────────────────────────────────────

const STRIPPABLE_SUFFIXES = [
  "-latest",
  "-preview",
  "-instruct",
  "-thinking",
  "-free",
  "-online",
  "-nightly",
  "-beta",
  "-exp",
  "-experimental",
];

/** Different-priced tiers — never collapse (would fuzzy-match parents at 0.84). */
const TIER_SUFFIXES = [
  "-highspeed",
  "-fast",
  "-pro",
  "-air",
  "-flash",
  "-mini",
  "-nano",
  "-turbo",
  "-lite",
  "-max",
  "-ultra",
  "-plus",
  "-standard",
  "-economy",
  "-coder",
  "-code",
  "-vision",
  "-image",
  "-audio",
];

const DATE_SUFFIX_PATTERNS = [
  /-\d{8}$/, // -20250929
  /-\d{4}-\d{2}-\d{2}$/, // -2025-12-11
  /-\d{2}-\d{4}$/, // -11-2025
  /-\d{2}-\d{2}$/, // -05-06
  /-\d{4}-\d{2}$/, // -2025-03
];

function getTierSuffix(normalized: string): string | null {
  for (const s of TIER_SUFFIXES) {
    if (normalized.endsWith(s)) return s;
  }
  return null;
}

function tierSuffixMismatch(a: string, b: string): boolean {
  const sa = getTierSuffix(a);
  const sb = getTierSuffix(b);
  if (sa === null && sb === null) return false;
  return sa !== sb;
}

/** Lowercase, qwen2→qwen-2, 2.5→2-5, strip dates, collapse dashes. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1-$2")
    .replace(/(\d+)\.(\d+)/g, "$1-$2")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{2}-\d{4}$/, "")
    .replace(/-\d{2}-\d{2}$/, "")
    .replace(/-\d{4}-\d{2}$/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
}

/** Generate progressively stripped variants of a normalized name. */
function strippedVariants(name: string): string[] {
  const variants: string[] = [];
  let current = name;

  for (const suffix of STRIPPABLE_SUFFIXES) {
    if (current.endsWith(suffix)) {
      current = current.slice(0, -suffix.length).replace(/-$/, "");
      variants.push(current);
    }
  }

  for (const pattern of DATE_SUFFIX_PATTERNS) {
    const match = current.match(pattern);
    if (match) {
      current = current.slice(0, -match[0].length).replace(/-$/, "");
      variants.push(current);
      break;
    }
  }

  const originalTokens = name.split("-");
  const minTokens = Math.max(2, Math.ceil(originalTokens.length * 0.6));
  const tokens = current.split("-");
  while (tokens.length > minTokens) {
    tokens.pop();
    variants.push(tokens.join("-"));
  }

  return variants;
}

/** Dice coefficient on normalized tokens with size penalty. */
function similarity(a: string, b: string): number {
  const aTokens = new Set(normalize(a).split("-").filter(Boolean));
  const bTokens = new Set(normalize(b).split("-").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const t of aTokens) {
    if (bTokens.has(t)) intersection++;
  }
  const dice = (2 * intersection) / (aTokens.size + bTokens.size);
  const sizePenalty =
    Math.abs(aTokens.size - bTokens.size) /
    Math.max(aTokens.size, bTokens.size);
  return dice * (1 - sizePenalty * 0.3);
}

export interface FuzzyIndex<T> {
  candidates: Map<string, T>;
  normalized: Map<string, string[]>; // normalize(key) -> original keys
}

export function buildFuzzyIndex<T>(candidates: Map<string, T>): FuzzyIndex<T> {
  const normalized = new Map<string, string[]>();
  for (const key of candidates.keys()) {
    const norm = normalize(key);
    const bucket = normalized.get(norm);
    if (bucket) bucket.push(key);
    else normalized.set(norm, [key]);
  }
  return { candidates, normalized };
}

/** Chain: normalized exact → stripped query → stripped candidates → prefix. Non-exact matches must pass threshold AND tier-suffix check. */
function fuzzyLookup<T>(
  name: string,
  index: FuzzyIndex<T>,
  threshold = 0.75,
): { key: string; value: T; score: number } | undefined {
  const norm = normalize(name);

  const resolve = (keys: string[]): { key: string; value: T } | undefined => {
    const k = keys[0];
    if (!k) return undefined;
    const v = index.candidates.get(k);
    if (v === undefined) return undefined;
    return { key: k, value: v };
  };

  // Exact normalized match short-circuits the tier check.
  const exact = index.normalized.get(norm);
  if (exact) {
    const r = resolve(exact);
    if (r) return { ...r, score: 1.0 };
  }

  const tierOk = (candidateKey: string): boolean =>
    !tierSuffixMismatch(norm, normalize(candidateKey));

  for (const variant of strippedVariants(norm)) {
    const hit = index.normalized.get(variant);
    if (hit) {
      const r = resolve(hit);
      if (r && tierOk(r.key)) {
        const score = similarity(name, r.key);
        if (score >= threshold) return { ...r, score };
      }
    }
  }

  let best: { key: string; value: T; score: number } | undefined;
  for (const [cNorm, originalKeys] of index.normalized) {
    for (const variant of strippedVariants(cNorm)) {
      if (variant === norm) {
        const r = resolve(originalKeys);
        if (r && tierOk(r.key)) {
          const score = similarity(name, r.key);
          if (score >= threshold && (!best || score > best.score)) {
            best = { ...r, score };
          }
        }
        break;
      }
    }
  }
  if (best) return best;

  for (const [cNorm, originalKeys] of index.normalized) {
    if (cNorm.startsWith(norm + "-") || norm.startsWith(cNorm + "-")) {
      const r = resolve(originalKeys);
      if (r && tierOk(r.key)) {
        const score = similarity(name, r.key);
        if (score >= threshold && (!best || score > best.score)) {
          best = { ...r, score };
        }
      }
    }
  }

  return best;
}

/** Tries the model name first, then the reverse-mapped original. */
export function lookup<T>(
  modelName: string,
  index: FuzzyIndex<T>,
  reverseMapping: Map<string, string>,
): { key: string; value: T; score: number } | undefined {
  const result = fuzzyLookup(modelName, index);
  if (result) return result;
  const originalName = reverseMapping.get(modelName);
  if (originalName) return fuzzyLookup(originalName, index);
  return undefined;
}

// ─── Main builder ────────────────────────────────────────────────────────
// Description: OpenRouter preferred, basellm fallback (skip template). Tags: basellm only.
export function buildMetadataMap(opts: {
  modelNames: Iterable<string>;
  basellmEntries: BasellmEntry[];
  openRouterDescriptions: Map<string, string>;
  modelMapping: Record<string, string>;
}): Map<string, ModelMetadata> {
  const { modelNames, basellmEntries, openRouterDescriptions, modelMapping } =
    opts;
  // Build basellm lookup, storing under both full and bare names
  const basellmMap = new Map<string, { description?: string; tags?: string }>();
  const addToBasellm = (key: string, entry: BasellmEntry) => {
    const existing = basellmMap.get(key);
    if (!existing) {
      basellmMap.set(key, {
        description: entry.description
          ? stripMarkdown(entry.description)
          : undefined,
        tags: entry.tags,
      });
    } else {
      if (
        existing.description &&
        TEMPLATE_DESCRIPTION_RE.test(existing.description) &&
        entry.description &&
        !TEMPLATE_DESCRIPTION_RE.test(entry.description)
      ) {
        existing.description = entry.description
          ? stripMarkdown(entry.description)
          : entry.description;
      }
      if (!existing.tags && entry.tags) existing.tags = entry.tags;
    }
  };
  for (const entry of basellmEntries) {
    if (!entry.model_name) continue;
    addToBasellm(entry.model_name, entry);
    const slashIdx = entry.model_name.indexOf("/");
    if (slashIdx >= 0)
      addToBasellm(entry.model_name.slice(slashIdx + 1), entry);
  }

  const reverseMapping = buildReverseMapping(modelMapping);

  const orIndex = buildFuzzyIndex(openRouterDescriptions);
  const blmIndex = buildFuzzyIndex(basellmMap);

  const result = new Map<string, ModelMetadata>();
  let orHits = 0;
  let orFuzzyHits = 0;
  let blmHits = 0;
  let blmFuzzyHits = 0;

  for (const modelName of modelNames) {
    const meta: ModelMetadata = {};

    const orResult = lookup(modelName, orIndex, reverseMapping);
    if (orResult) {
      meta.description = orResult.value;
      orHits++;
      if (orResult.score < 1.0) {
        orFuzzyHits++;
        consola.debug(
          t("CORE.METADATA.FUZZY_OR", {
            model: modelName,
            key: orResult.key,
            score: orResult.score.toFixed(2),
          }),
        );
      }
    } else {
      const blmResult = lookup(modelName, blmIndex, reverseMapping);
      if (
        blmResult?.value.description &&
        !TEMPLATE_DESCRIPTION_RE.test(blmResult.value.description)
      ) {
        meta.description = blmResult.value.description;
        blmHits++;
        if (blmResult.score < 1.0) {
          blmFuzzyHits++;
          consola.debug(
            t("CORE.METADATA.FUZZY_BLM_DESC", {
              model: modelName,
              key: blmResult.key,
              score: blmResult.score.toFixed(2),
            }),
          );
        }
      }
    }

    const blmResult = lookup(modelName, blmIndex, reverseMapping);
    if (blmResult?.value.tags) {
      if (blmResult.score < 1.0) {
        consola.debug(
          t("CORE.METADATA.FUZZY_BLM_TAGS", {
            model: modelName,
            key: blmResult.key,
            score: blmResult.score.toFixed(2),
          }),
        );
      }
      let tags = blmResult.value.tags;
      if (tags.length > 255) {
        const lastComma = tags.slice(0, 255).lastIndexOf(",");
        tags = lastComma > 0 ? tags.slice(0, lastComma) : tags.slice(0, 255);
      }
      meta.tags = tags;
    }

    if (meta.description || meta.tags) result.set(modelName, meta);
  }

  consola.info(
    t("CORE.METADATA.SUMMARY", {
      orHits,
      orFuzzy: orFuzzyHits,
      blmHits,
      blmFuzzy: blmFuzzyHits,
      total: result.size,
    }),
  );
  return result;
}
