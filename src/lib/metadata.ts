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

type BasellmResponse = BasellmEntry[] | { success: boolean; data: BasellmEntry[] };

export interface ModelMetadata {
  description?: string;
  tags?: string;
}

// ---- Fetchers ----

/** Fetch OpenRouter models and return a map of bare model name → description. */
export async function fetchOpenRouterDescriptions(): Promise<Map<string, string>> {
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
    // Keep first occurrence (duplicates from different providers)
    if (!map.has(bareName)) {
      map.set(bareName, model.description);
    }
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

// ---- Matching helpers ----

/**
 * Normalize a model name for fuzzy matching:
 * - lowercase
 * - version dots to dashes (4.5 → 4-5)
 * - strip YYYYMMDD date suffixes
 */
function normalizeForMatching(name: string): string {
  return name
    .toLowerCase()
    .replace(/(\d+)\.(\d+)/g, "$1-$2")
    .replace(/-\d{8}$/, "");
}

/**
 * Look up an OpenRouter description for a given model name.
 * Tries exact match, then normalized match, then reverse model mapping.
 */
function lookupDescription(
  modelName: string,
  orMap: Map<string, string>,
  reverseMapping: Map<string, string>,
): string | undefined {
  // Exact match
  const direct = orMap.get(modelName);
  if (direct) return direct;

  // Normalized match
  const normalized = normalizeForMatching(modelName);
  for (const [orName, desc] of orMap) {
    if (normalizeForMatching(orName) === normalized) return desc;
  }

  // Try original name via reverse mapping
  const originalName = reverseMapping.get(modelName);
  if (originalName) {
    const mapped = orMap.get(originalName);
    if (mapped) return mapped;
    const origNorm = normalizeForMatching(originalName);
    for (const [orName, desc] of orMap) {
      if (normalizeForMatching(orName) === origNorm) return desc;
    }
  }

  return undefined;
}

// ---- Main builder ----

/**
 * Build a unified metadata map for all desired models.
 * - Description: OpenRouter preferred, basellm fallback (if not template)
 * - Tags: basellm only
 */
export function buildMetadataMap(
  modelNames: Iterable<string>,
  basellmEntries: BasellmEntry[],
  openRouterDescriptions: Map<string, string>,
  modelMapping: Record<string, string>,
): Map<string, ModelMetadata> {
  // Build basellm lookup: model_name → { description, tags }
  // For duplicates, keep the entry with the best description and merge tags
  const basellmMap = new Map<string, { description?: string; tags?: string }>();
  for (const entry of basellmEntries) {
    if (!entry.model_name) continue;
    const existing = basellmMap.get(entry.model_name);
    if (!existing) {
      basellmMap.set(entry.model_name, {
        description: entry.description,
        tags: entry.tags,
      });
    } else if (
      // Prefer non-template description over template
      existing.description &&
      TEMPLATE_DESCRIPTION_RE.test(existing.description) &&
      entry.description &&
      !TEMPLATE_DESCRIPTION_RE.test(entry.description)
    ) {
      existing.description = entry.description;
    }
    // Keep first tags (they're the same across vendors for the same model)
    if (!existing?.tags && entry.tags) {
      const e = basellmMap.get(entry.model_name);
      if (e) e.tags = entry.tags;
    }
  }

  // Build reverse mapping (mapped name → original name)
  const reverseMapping = new Map<string, string>();
  for (const [original, mapped] of Object.entries(modelMapping)) {
    reverseMapping.set(mapped, original);
  }

  const result = new Map<string, ModelMetadata>();
  let orHits = 0;
  let blmHits = 0;

  for (const modelName of modelNames) {
    const meta: ModelMetadata = {};

    // Description: try OpenRouter first
    const orDesc = lookupDescription(modelName, openRouterDescriptions, reverseMapping);
    if (orDesc) {
      meta.description = orDesc;
      orHits++;
    } else {
      // Fallback to basellm, skip template descriptions
      const blmName = reverseMapping.get(modelName) ?? modelName;
      const blm = basellmMap.get(blmName) ?? basellmMap.get(modelName);
      if (blm?.description && !TEMPLATE_DESCRIPTION_RE.test(blm.description)) {
        meta.description = blm.description;
        blmHits++;
      }
    }

    // Tags: always from basellm
    const blmName = reverseMapping.get(modelName) ?? modelName;
    const blm = basellmMap.get(blmName) ?? basellmMap.get(modelName);
    if (blm?.tags) {
      // Truncate to 255 chars at the last comma boundary
      let tags = blm.tags;
      if (tags.length > 255) {
        const truncated = tags.slice(0, 255);
        const lastComma = truncated.lastIndexOf(",");
        tags = lastComma > 0 ? truncated.slice(0, lastComma) : truncated;
      }
      meta.tags = tags;
    }

    if (meta.description || meta.tags) {
      result.set(modelName, meta);
    }
  }

  consola.info(
    `Metadata: ${orHits} descriptions from OpenRouter, ${blmHits} from basellm fallback, ${result.size} models enriched total`,
  );
  return result;
}
