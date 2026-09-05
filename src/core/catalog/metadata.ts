import { buildReverseMapping } from "@core/catalog/constants/patterns";
import { tryFetchJson } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import removeMd from "remove-markdown";

// Frontend catalog, NOT the public /api/v1/models: the public endpoint truncates
// descriptions to ~226 chars ("...low, medium, high, max,..."), the frontend
// catalog serves the full text.
const OPENROUTER_MODELS_URL =
  "https://openrouter.ai/api/frontend/v1/catalog/models";
const BASELLM_MODELS_URL =
  "https://basellm.github.io/llm-metadata/api/newapi/models.json";
const TEMPLATE_DESCRIPTION_RE = /^.+ is an AI model provided by .+\.$/;

// basellm carries one entry per model PER VENDOR, and the relays that resell a model
// frequently ship a generic category blurb instead of a real description ("Compact GPT
// model for low-latency assistance...", reused across 286 distinct model names covering
// Claude, DeepSeek and GLM alike). Picking the first entry per key therefore mislabels
// whichever model the bad vendor happens to be listed under first.
// prettier-ignore
const DESCRIPTION_FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ["gpt", /\bgpt\b/i], ["claude", /\bclaude\b/i], ["gemini", /\bgemini\b/i],
  ["glm", /\bglm\b/i], ["qwen", /\bqwen\b/i], ["llama", /\bllama\b/i],
  ["deepseek", /\bdeepseek\b/i], ["mistral", /\bmistral\b/i], ["kimi", /\bkimi\b/i],
  ["gemma", /\bgemma\b/i], ["ernie", /\bernie\b/i], ["minimax", /\bminimax\b/i],
  ["grok", /\bgrok\b/i], ["nova", /\bnova\b/i], ["phi", /\bphi[- ]?\d/i],
  ["doubao", /\bdoubao\b/i], ["command", /\bcommand[- ]?[ar]\d*\b/i], ["seedance", /\bseedance\b/i],
  ["venice", /\bvenice\b/i], ["kat", /\bkat[- ]?(coder|dev|\d)/i], ["hunyuan", /\bhunyuan\b/i],
  ["yi", /\byi[- ]?\d/i], ["step", /\bstep[- ]?\d/i], ["moonshot", /\bmoonshot\b/i],
];

const familiesIn = (text: string): string[] =>
  DESCRIPTION_FAMILIES.filter(([, re]) => re.test(text)).map(([name]) => name);

// A description that names a model family the model name contradicts is always wrong,
// however specific it reads: "Chat-tuned GPT model" on deepseek-chat outranks the correct
// DeepSeek blurb on reuse count alone.
export function contradictsFamily(
  modelName: string,
  description: string,
): boolean {
  const nameFamilies = familiesIn(modelName);
  if (nameFamilies.length === 0) return false;
  const descFamilies = familiesIn(description);
  if (descFamilies.length === 0) return false;
  return !descFamilies.some((f) => nameFamilies.includes(f));
}

const stripMarkdown = (text: string): string =>
  removeMd(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

interface OpenRouterModel {
  slug: string;
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
    if (!model.slug || !model.description) continue;
    const slashIdx = model.slug.indexOf("/");
    const bareName =
      slashIdx >= 0 ? model.slug.slice(slashIdx + 1) : model.slug;
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
const STRIPPABLE_SUFFIXES = ["-latest","-preview","-instruct","-thinking","-think","-free","-online","-nightly","-beta","-exp","-experimental","-search","-search-preview","-search-api","-openai-compact"];
// prettier-ignore
const TIER_SUFFIXES = ["-highspeed","-fast","-pro","-air","-flash","-mini","-nano","-turbo","-lite","-max","-ultra","-plus","-standard","-economy","-coder","-code","-vision","-image","-audio"];
// prettier-ignore
const DATE_SUFFIX_PATTERNS = [/-\d{8}$/,/-\d{4}-\d{2}-\d{2}$/,/-\d{2}-\d{4}$/,/-\d{2}-\d{2}$/,/-\d{4}-\d{2}$/];

const getTierSuffix = (n: string): string | null =>
  TIER_SUFFIXES.find((s) => n.endsWith(s)) ?? null;

function tierSuffixMismatch(a: string, b: string): boolean {
  const sa = getTierSuffix(a),
    sb = getTierSuffix(b);
  return (sa !== null || sb !== null) && sa !== sb;
}

// DashScope/relay task-endpoint suffixes appended after a "/" (kling-3.0-turbo/
// image-to-video, viduq3-pro/text-to-video, eleven_flash_v2_5/text-to-speech).
// These are routing markers, not part of the model identity, so strip them before
// metadata lookup. NOT a general slash strip (Cloudflare "@cf/org/model" keeps its).
const TASK_SUFFIX =
  /\/(?:image|text|start-end|video|audio|speech)-to-(?:video|image|speech|text|audio)$/;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(TASK_SUFFIX, "")
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
  const trim = (len: number) => {
    current = current.slice(0, -len).replace(/-$/, "");
    variants.push(current);
  };
  // Repeat until nothing matches: these suffixes stack. A single pass over the list left
  // glm-5-turbo-think-search at "glm-5-turbo-think", which matches no known model, so the
  // whole GLM search/thinking family resolved to no metadata at all.
  for (let pass = 0; pass < STRIPPABLE_SUFFIXES.length; pass++) {
    const hit = STRIPPABLE_SUFFIXES.find((s) => current.endsWith(s));
    if (!hit) break;
    trim(hit.length);
  }
  for (const pattern of DATE_SUFFIX_PATTERNS) {
    const match = current.match(pattern);
    if (match) {
      trim(match[0].length);
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
  const score = (keys: string[] | undefined): Hit | undefined => {
    const k = keys?.[0];
    if (!k) return undefined;
    const v = index.candidates.get(k);
    if (v === undefined || tierSuffixMismatch(norm, normalize(k)))
      return undefined;
    const s = similarity(name, k);
    return s < threshold ? undefined : { key: k, value: v, score: s };
  };
  const exactKey = index.normalized.get(norm)?.[0];
  if (exactKey) {
    const v = index.candidates.get(exactKey);
    if (v !== undefined) return { key: exactKey, value: v, score: 1.0 };
  }
  for (const variant of strippedVariants(norm)) {
    // A stripped variant that EXACTLY equals a candidate's normalized key is a
    // direct hit (e.g. "gpt-5-5-search" -> "gpt-5-5" == gpt-5.5). Skip the token-
    // similarity gate, which under-scores repeated-digit names (the two 5s in 5.5
    // collapse in the token Set, dropping dice below threshold).
    const keys = index.normalized.get(variant);
    const directKey = keys?.[0];
    // No tier check here: the variant IS this name with its suffixes removed, so it can
    // only ever carry the same tier. Comparing the ORIGINAL against it rejected the right
    // answer, because a suffix hides the tier - glm-5-turbo-search reads as tier-less next
    // to glm-5-turbo and looked like a -turbo/none mismatch. The guard still applies to the
    // similarity path below, where the two names are genuinely unrelated.
    if (directKey) {
      const v = index.candidates.get(directKey);
      if (v !== undefined) return { key: directKey, value: v, score: 1.0 };
    }
    const hit = score(keys);
    if (hit) return hit;
  }
  let best: Hit | undefined;
  const consider = (hit: Hit | undefined) => {
    if (hit && (!best || hit.score > best.score)) best = hit;
  };
  for (const [cNorm, keys] of index.normalized) {
    for (const variant of strippedVariants(cNorm)) {
      // Exact match on the candidate's own stripped form, so this is the same model by
      // construction and the tier guard in score() would only reject it: our name can carry
      // a tier the candidate hides behind a suffix (gemini-flash-lite vs
      // gemini-flash-lite-latest read as -lite against none).
      if (variant === norm) {
        const k = keys?.[0];
        const v = k ? index.candidates.get(k) : undefined;
        if (k && v !== undefined) consider({ key: k, value: v, score: 1.0 });
        break;
      }
    }
  }
  if (best) return best;
  for (const [cNorm, keys] of index.normalized) {
    if (cNorm.startsWith(norm + "-") || norm.startsWith(cNorm + "-"))
      consider(score(keys));
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
  return originalName ? fuzzyLookup(originalName, index) : undefined;
}

export function buildMetadataMap(opts: {
  modelNames: Iterable<string>;
  basellmEntries: BasellmEntry[];
  openRouterDescriptions: Map<string, string>;
  modelMapping: Record<string, string>;
}): Map<string, ModelMetadata> {
  // How many distinct models each description is attached to. A blurb shared by hundreds
  // of unrelated models says nothing about any one of them, so it loses to a rarer one.
  const descriptionReuse = new Map<string, Set<string>>();
  for (const entry of opts.basellmEntries) {
    const description = entry.description?.trim();
    if (!description || !entry.model_name) continue;
    let models = descriptionReuse.get(description);
    if (!models) descriptionReuse.set(description, (models = new Set()));
    models.add(entry.model_name);
  }
  const reuseCount = (description: string): number =>
    descriptionReuse.get(description.trim())?.size ?? Number.MAX_SAFE_INTEGER;

  // Lower is better. Template and family-contradicting text is disqualified outright
  // rather than merely ranked down, so a model with only bad candidates gets no
  // description at all instead of a confidently wrong one.
  const rank = (key: string, description: string): number => {
    if (TEMPLATE_DESCRIPTION_RE.test(description))
      return Number.MAX_SAFE_INTEGER;
    if (contradictsFamily(key, description)) return Number.MAX_SAFE_INTEGER;
    return reuseCount(description);
  };

  const basellmMap = new Map<string, { description?: string; tags?: string }>();
  const bestRank = new Map<string, number>();
  for (const entry of opts.basellmEntries) {
    if (!entry.model_name) continue;
    const slashIdx = entry.model_name.indexOf("/");
    const keys =
      slashIdx >= 0
        ? [entry.model_name, entry.model_name.slice(slashIdx + 1)]
        : [entry.model_name];
    for (const key of keys) {
      // Only materialise a key once it has something worth carrying: an entry holding
      // neither a usable description nor tags still occupies the fuzzy index and shadows
      // a later entry that does.
      const candidate = entry.description?.trim();
      const usable =
        candidate && rank(key, candidate) !== Number.MAX_SAFE_INTEGER;
      let existing = basellmMap.get(key);
      if (!existing) {
        if (!usable && !entry.tags) continue;
        basellmMap.set(key, (existing = {}));
      }
      if (candidate) {
        const candidateRank = rank(key, candidate);
        const currentRank = bestRank.get(key) ?? Number.MAX_SAFE_INTEGER;
        if (candidateRank < currentRank) {
          bestRank.set(key, candidateRank);
          existing.description = stripMarkdown(candidate);
        }
      }
      if (!existing.tags && entry.tags) existing.tags = entry.tags;
    }
  }

  const reverseMapping = buildReverseMapping(opts.modelMapping);
  const orIndex = buildFuzzyIndex(opts.openRouterDescriptions);
  const blmIndex = buildFuzzyIndex(basellmMap);
  const result = new Map<string, ModelMetadata>();
  const counters = { orHits: 0, orFuzzy: 0, blmHits: 0, blmFuzzy: 0 };

  for (const modelName of opts.modelNames) {
    const meta: ModelMetadata = {};
    const orResult = lookup(modelName, orIndex, reverseMapping);
    const blmResult = lookup(modelName, blmIndex, reverseMapping);
    if (orResult) {
      meta.description = orResult.value;
      counters.orHits++;
      if (orResult.score < 1.0) counters.orFuzzy++;
    } else if (
      blmResult?.value.description &&
      !TEMPLATE_DESCRIPTION_RE.test(blmResult.value.description)
    ) {
      meta.description = blmResult.value.description;
      counters.blmHits++;
      if (blmResult.score < 1.0) counters.blmFuzzy++;
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

  consola.info(t("CORE.METADATA.SUMMARY", { ...counters, total: result.size }));
  return result;
}
