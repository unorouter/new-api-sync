import { buildReverseMapping } from "@/lib/constants";
import { tryFetchJson } from "@/lib/http";
import { consola } from "consola";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const BASELLM_MODELS_URL =
  "https://basellm.github.io/llm-metadata/api/newapi/models.json";

// Template description pattern from basellm (auto-generated, not useful)
const TEMPLATE_DESCRIPTION_RE = /^.+ is an AI model provided by .+\.$/;

// ---- Raw API response types ----

interface OpenRouterModel {
  id: string; // "anthropic/claude-opus-4.5"
  description: string;
}

export interface BasellmEntry {
  model_name: string;
  description?: string;
  tags?: string; // "Reasoning,Tools,Files,Vision,128K"
  ratio_model: number;
  ratio_completion: number;
}

type BasellmResponse =
  | BasellmEntry[]
  | { success: boolean; data: BasellmEntry[] };

export interface ModelMetadata {
  description?: string;
  tags?: string;
}

// ---- Fetchers ----

/** Fetch OpenRouter models and return a map of bare model name → description. */
export async function fetchOpenRouterDescriptions(): Promise<
  Map<string, string>
> {
  const raw = await tryFetchJson<{ data: OpenRouterModel[] }>(
    OPENROUTER_MODELS_URL,
    { timeoutMs: 15_000 },
  );
  const map = new Map<string, string>();
  if (!raw?.data || !Array.isArray(raw.data)) {
    consola.warn("Failed to fetch OpenRouter models for descriptions");
    return map;
  }

  for (const model of raw.data) {
    if (!model.id || !model.description) continue;
    const slashIdx = model.id.indexOf("/");
    const bareName = slashIdx >= 0 ? model.id.slice(slashIdx + 1) : model.id;
    if (!map.has(bareName)) map.set(bareName, model.description);
  }

  consola.info(`Fetched ${map.size} model descriptions from OpenRouter`);
  return map;
}

/** Fetch basellm model entries (reused for both ratios and metadata). */
export async function fetchBasellmEntries(): Promise<BasellmEntry[]> {
  const raw = await tryFetchJson<BasellmResponse>(BASELLM_MODELS_URL, {
    timeoutMs: 15_000,
  });
  if (!raw) {
    consola.warn("Failed to fetch basellm model library");
    return [];
  }
  const entries = Array.isArray(raw) ? raw : raw.data;
  if (!Array.isArray(entries)) return [];
  consola.info(`Fetched ${entries.length} model entries from basellm`);
  return entries;
}

// ---- Fuzzy matching ----

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

const DATE_SUFFIX_PATTERNS = [
  /-\d{8}$/, // -20250929
  /-\d{4}-\d{2}-\d{2}$/, // -2025-12-11
  /-\d{2}-\d{4}$/, // -11-2025
  /-\d{2}-\d{2}$/, // -05-06
  /-\d{4}-\d{2}$/, // -2025-03
];

/**
 * Normalize a model name for matching:
 * - lowercase
 * - insert dash at letter-digit boundaries (qwen2 -> qwen-2)
 * - version dots to dashes (2.5 -> 2-5)
 * - strip all date suffix formats
 * - collapse multiple dashes
 */
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

interface FuzzyIndex<T> {
  candidates: Map<string, T>;
  normalized: Map<string, string[]>; // normalize(key) -> original keys
}

function buildFuzzyIndex<T>(candidates: Map<string, T>): FuzzyIndex<T> {
  const normalized = new Map<string, string[]>();
  for (const key of candidates.keys()) {
    const norm = normalize(key);
    const bucket = normalized.get(norm);
    if (bucket) bucket.push(key);
    else normalized.set(norm, [key]);
  }
  return { candidates, normalized };
}

/**
 * Find the best matching candidate for a model name.
 * Chain: normalized exact -> stripped query -> stripped candidates -> prefix containment.
 * All non-exact matches verified with similarity >= threshold.
 */
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

  // Normalized exact match
  const exact = index.normalized.get(norm);
  if (exact) {
    const r = resolve(exact);
    if (r) return { ...r, score: 1.0 };
  }

  // Stripped variants of query
  for (const variant of strippedVariants(norm)) {
    const hit = index.normalized.get(variant);
    if (hit) {
      const r = resolve(hit);
      if (r) {
        const score = similarity(name, r.key);
        if (score >= threshold) return { ...r, score };
      }
    }
  }

  // Stripped variants of candidates
  let best: { key: string; value: T; score: number } | undefined;
  for (const [cNorm, originalKeys] of index.normalized) {
    for (const variant of strippedVariants(cNorm)) {
      if (variant === norm) {
        const r = resolve(originalKeys);
        if (r) {
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

  // Prefix containment
  for (const [cNorm, originalKeys] of index.normalized) {
    if (cNorm.startsWith(norm + "-") || norm.startsWith(cNorm + "-")) {
      const r = resolve(originalKeys);
      if (r) {
        const score = similarity(name, r.key);
        if (score >= threshold && (!best || score > best.score)) {
          best = { ...r, score };
        }
      }
    }
  }

  return best;
}

/**
 * Lookup a value from a fuzzy index, trying the model name and optionally
 * the original (reverse-mapped) name.
 */
function lookup<T>(
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

// ---- Main builder ----

/**
 * Build a unified metadata map for all desired models.
 * - Description: OpenRouter preferred, basellm fallback (if not template)
 * - Tags: basellm only
 */
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
      basellmMap.set(key, { description: entry.description, tags: entry.tags });
    } else {
      if (
        existing.description &&
        TEMPLATE_DESCRIPTION_RE.test(existing.description) &&
        entry.description &&
        !TEMPLATE_DESCRIPTION_RE.test(entry.description)
      ) {
        existing.description = entry.description;
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

  // Build fuzzy indices once
  const orIndex = buildFuzzyIndex(openRouterDescriptions);
  const blmIndex = buildFuzzyIndex(basellmMap);

  const result = new Map<string, ModelMetadata>();
  let orHits = 0;
  let orFuzzyHits = 0;
  let blmHits = 0;
  let blmFuzzyHits = 0;

  for (const modelName of modelNames) {
    const meta: ModelMetadata = {};

    // Description: OpenRouter first, basellm fallback
    const orResult = lookup(modelName, orIndex, reverseMapping);
    if (orResult) {
      meta.description = orResult.value;
      orHits++;
      if (orResult.score < 1.0) {
        orFuzzyHits++;
        consola.debug(
          `Fuzzy OR: "${modelName}" -> "${orResult.key}" (${orResult.score.toFixed(2)})`,
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
            `Fuzzy BLM desc: "${modelName}" -> "${blmResult.key}" (${blmResult.score.toFixed(2)})`,
          );
        }
      }
    }

    // Tags: always from basellm
    const blmResult = lookup(modelName, blmIndex, reverseMapping);
    if (blmResult?.value.tags) {
      if (blmResult.score < 1.0) {
        consola.debug(
          `Fuzzy BLM tags: "${modelName}" -> "${blmResult.key}" (${blmResult.score.toFixed(2)})`,
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
    `Metadata: ${orHits} from OpenRouter (${orFuzzyHits} fuzzy), ${blmHits} from basellm (${blmFuzzyHits} fuzzy), ${result.size} enriched total`,
  );
  return result;
}
