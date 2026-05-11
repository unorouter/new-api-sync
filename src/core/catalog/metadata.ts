import { buildReverseMapping } from "@core/catalog/constants/patterns";
import { tryFetchJson } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import removeMd from "remove-markdown";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const BASELLM_MODELS_URL =
  "https://basellm.github.io/llm-metadata/api/newapi/models.json";
const TEMPLATE_DESCRIPTION_RE = /^.+ is an AI model provided by .+\.$/;

const stripMarkdown = (text: string): string =>
  removeMd(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

interface OpenRouterModel {
  id: string;
  description: string;
}

export interface BasellmEntry {
  model_name: string;
  description?: string;
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

// prettier-ignore
const STRIPPABLE_SUFFIXES = ["-latest","-preview","-instruct","-thinking","-free","-online","-nightly","-beta","-exp","-experimental"];
// prettier-ignore
const TIER_SUFFIXES = ["-highspeed","-fast","-pro","-air","-flash","-mini","-nano","-turbo","-lite","-max","-ultra","-plus","-standard","-economy","-coder","-code","-vision","-image","-audio"];
// prettier-ignore
const DATE_SUFFIX_PATTERNS = [/-\d{8}$/,/-\d{4}-\d{2}-\d{2}$/,/-\d{2}-\d{4}$/,/-\d{2}-\d{2}$/,/-\d{4}-\d{2}$/];

const getTierSuffix = (n: string): string | null =>
  TIER_SUFFIXES.find((s) => n.endsWith(s)) ?? null;

function tierSuffixMismatch(a: string, b: string): boolean {
  const sa = getTierSuffix(a);
  const sb = getTierSuffix(b);
  return (sa !== null || sb !== null) && sa !== sb;
}

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
  const minTokens = Math.max(2, Math.ceil(name.split("-").length * 0.6));
  const tokens = current.split("-");
  while (tokens.length > minTokens) {
    tokens.pop();
    variants.push(tokens.join("-"));
  }
  return variants;
}

function similarity(a: string, b: string): number {
  const aT = new Set(normalize(a).split("-").filter(Boolean));
  const bT = new Set(normalize(b).split("-").filter(Boolean));
  if (aT.size === 0 || bT.size === 0) return 0;
  let intersection = 0;
  for (const tok of aT) if (bT.has(tok)) intersection++;
  const dice = (2 * intersection) / (aT.size + bT.size);
  const penalty = Math.abs(aT.size - bT.size) / Math.max(aT.size, bT.size);
  return dice * (1 - penalty * 0.3);
}

export interface FuzzyIndex<T> {
  candidates: Map<string, T>;
  normalized: Map<string, string[]>;
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

function fuzzyLookup<T>(
  name: string,
  index: FuzzyIndex<T>,
  threshold = 0.75,
): { key: string; value: T; score: number } | undefined {
  const norm = normalize(name);
  type Hit = { key: string; value: T; score: number };
  const resolve = (
    keys: string[] | undefined,
  ): { key: string; value: T } | undefined => {
    const k = keys?.[0];
    if (!k) return undefined;
    const v = index.candidates.get(k);
    return v === undefined ? undefined : { key: k, value: v };
  };

  const exact = resolve(index.normalized.get(norm));
  if (exact) return { ...exact, score: 1.0 };

  let best: Hit | undefined;
  const tryMatch = (
    keys: string[] | undefined,
    updateBest: boolean,
  ): Hit | undefined => {
    const r = resolve(keys);
    if (!r || tierSuffixMismatch(norm, normalize(r.key))) return undefined;
    const score = similarity(name, r.key);
    if (score < threshold) return undefined;
    const hit = { ...r, score };
    if (updateBest && (!best || score > best.score)) best = hit;
    return hit;
  };

  for (const variant of strippedVariants(norm)) {
    const hit = tryMatch(index.normalized.get(variant), false);
    if (hit) return hit;
  }
  for (const [cNorm, keys] of index.normalized) {
    for (const variant of strippedVariants(cNorm)) {
      if (variant === norm) {
        tryMatch(keys, true);
        break;
      }
    }
  }
  if (best) return best;
  for (const [cNorm, keys] of index.normalized) {
    if (cNorm.startsWith(norm + "-") || norm.startsWith(cNorm + "-"))
      tryMatch(keys, true);
  }
  return best;
}

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

export function buildMetadataMap(opts: {
  modelNames: Iterable<string>;
  basellmEntries: BasellmEntry[];
  openRouterDescriptions: Map<string, string>;
  modelMapping: Record<string, string>;
}): Map<string, ModelMetadata> {
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
      return;
    }
    if (
      existing.description &&
      TEMPLATE_DESCRIPTION_RE.test(existing.description) &&
      entry.description &&
      !TEMPLATE_DESCRIPTION_RE.test(entry.description)
    ) {
      existing.description = stripMarkdown(entry.description);
    }
    if (!existing.tags && entry.tags) existing.tags = entry.tags;
  };
  for (const entry of opts.basellmEntries) {
    if (!entry.model_name) continue;
    addToBasellm(entry.model_name, entry);
    const slashIdx = entry.model_name.indexOf("/");
    if (slashIdx >= 0)
      addToBasellm(entry.model_name.slice(slashIdx + 1), entry);
  }

  const reverseMapping = buildReverseMapping(opts.modelMapping);
  const orIndex = buildFuzzyIndex(opts.openRouterDescriptions);
  const blmIndex = buildFuzzyIndex(basellmMap);

  const result = new Map<string, ModelMetadata>();
  let orHits = 0,
    orFuzzyHits = 0,
    blmHits = 0,
    blmFuzzyHits = 0;

  for (const modelName of opts.modelNames) {
    const meta: ModelMetadata = {};
    const orResult = lookup(modelName, orIndex, reverseMapping);
    const blmResult = lookup(modelName, blmIndex, reverseMapping);

    if (orResult) {
      meta.description = orResult.value;
      orHits++;
      if (orResult.score < 1.0) orFuzzyHits++;
    } else if (
      blmResult?.value.description &&
      !TEMPLATE_DESCRIPTION_RE.test(blmResult.value.description)
    ) {
      meta.description = blmResult.value.description;
      blmHits++;
      if (blmResult.score < 1.0) blmFuzzyHits++;
    }

    if (blmResult?.value.tags) {
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
