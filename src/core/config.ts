import { MODEL_TYPES, type ModelType } from "@core/types";
import {
  ConfigSchema,
  GlobalConfigSchema,
  type AnyProviderConfig,
  type ConfigSchemaType,
  type EnabledModelEntry,
  type GlobalConfigType,
} from "@core/validations/config";
import { t } from "@server/i18n";
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";

// ─── Paths ─────────────────────────────────────────────────────────────────

/** Dev: process.cwd(). Compiled binary: dirname(execPath). Returns "" in browser bundle. */
export function configDir(): string {
  if (typeof process === "undefined") return "";
  const exe = process.execPath;
  const exeName = basename(exe).toLowerCase();
  const isBunRuntime = exeName === "bun" || exeName.startsWith("bun.");
  if (isBunRuntime) return process.cwd();
  return dirname(exe);
}

/** ${VAR} / ${VAR:-default} → process.env[VAR]. Unresolved left intact. */
function expandEnvVars(text: string): string {
  if (typeof process === "undefined") return text;
  return text.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi,
    (match, name, fallback) => {
      const v = process.env[name];
      if (v !== undefined) return v;
      if (fallback !== undefined) return fallback;
      return match;
    },
  );
}

// ─── Global config (config.global.yml) ────────────────────────────────────
// Cross-config: locale, theme, shared blacklist/modelMapping merged into every per-config.
export const GLOBAL_CONFIG_PATH = join(configDir(), "config.global.yml");

export async function loadGlobalConfig(): Promise<GlobalConfigType> {
  const file = Bun.file(GLOBAL_CONFIG_PATH);
  if (!(await file.exists())) return {};
  let parsedRaw: unknown;
  try {
    parsedRaw = Bun.YAML.parse(await file.text());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      t("ERROR.GLOBAL_CONFIG_INVALID_YAML", {
        path: GLOBAL_CONFIG_PATH,
        detail,
      }),
    );
  }
  if (parsedRaw === null || parsedRaw === undefined) return {};
  if (!Value.Check(GlobalConfigSchema, parsedRaw)) {
    const errors = [...Value.Errors(GlobalConfigSchema, parsedRaw)]
      .map((e) => `${e.path || "root"}: ${e.message}`)
      .join("\n");
    throw new Error(
      t("ERROR.GLOBAL_CONFIG_VALIDATION_FAILED", { detail: errors }),
    );
  }
  return parsedRaw as GlobalConfigType;
}

export async function writeGlobalConfig(next: GlobalConfigType): Promise<void> {
  const yaml = YAML.stringify(next, {
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
  });
  await Bun.write(GLOBAL_CONFIG_PATH, yaml);
}

// ─── enabledModels accessors ───────────────────────────────────────────────

const NON_TEXT_TYPES: Set<string> = new Set(
  MODEL_TYPES.filter((t) => t !== "text"),
);

/** Extract model glob strings from enabledModels (ignoring grid pricing metadata). */
export function getEnabledModelGlobs(
  entries: EnabledModelEntry[] | undefined,
): string[] | undefined {
  if (!entries) return undefined;
  return entries.map((e) => (typeof e === "string" ? e : e.model));
}

/** Extract pricing grid data from enabledModels into a model → rows map. */
export function getPricingGridFromEnabledModels(
  entries: EnabledModelEntry[] | undefined,
): Record<string, Record<string, string | number>[]> {
  const result: Record<string, Record<string, string | number>[]> = {};
  if (!entries) return result;
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    if ("modelPricingGrid" in entry && entry.modelPricingGrid) {
      result[entry.model] = entry.modelPricingGrid;
    }
  }
  return result;
}

/** Extract per-model metadata overrides from enabledModels. */
export function getMetadataFromEnabledModels(
  entries: EnabledModelEntry[] | undefined,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  if (!entries) return result;
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    if ("metadata" in entry && entry.metadata) {
      result[entry.model] = entry.metadata;
    }
  }
  return result;
}

// Defaults applied post-parse to match the previous Zod .default() semantics.
export const CONFIG_DEFAULTS = {
  skipUnprofitableText: true,
  globalConcurrency: 50,
  perUpstreamConcurrency: 5,
} as const;

/** Always-blacklist (broken upstreams, mis-served embed/audio/video). Substring against bare names. */
const BUILTIN_BLACKLIST: readonly string[] = [
  "ai-synthetic-video-detector",
  "arctic-embed-l",
  "bge-m3",
  "devstral-2-123b-instruct-2512",
  "embed-qa-4",
  "gliner-pii",
  "ising-calibration-1-35b-a3b",
  "laguna-m.1",
  "laguna-xs.2",
  "magistral-small-2506",
  "ministral-14b-instruct-2512",
  "mixtral-8x22b-instruct-v0.1",
  "mixtral-8x7b-instruct-v0.1",
  "nv-embed-v1",
  "nv-embedcode-7b-v1",
  "nv-embedqa-e5-v5",
  "owl-alpha",
  "phi-4-mini-instruct",
  "phi-4-multimodal-instruct",
  "riva-translate-4b-instruct-v1.1",
  "sarvam-m",
  "seed-oss-36b-instruct",
  "solar-10.7b-instruct",
  "step-3.5-flash",
  "stockmark-2-100b-instruct",
];

export interface RuntimeConfig extends Omit<
  ConfigSchemaType,
  | "blacklist"
  | "modelMapping"
  | "skipUnprofitableText"
  | "providers"
  | "globalConcurrency"
  | "perUpstreamConcurrency"
> {
  providers: AnyProviderConfig[];
  skipUnprofitableText: boolean;
  globalConcurrency: number;
  perUpstreamConcurrency: number;
  blacklist: string[];
  modelMapping: Record<string, string>;
  onlyProviders?: Set<string>;
  modelFilter?: string[];
  isTestMode?: boolean;
}

// ─── Validation helpers ────────────────────────────────────────────────────

/** Cross-field rules TypeBox can't express. Empty array = valid. */
export function customValidateConfig(config: ConfigSchemaType): string[] {
  const errors: string[] = [];

  const seen = new Set<string>();
  for (const [i, p] of config.providers.entries()) {
    if (seen.has(p.name)) {
      errors.push(
        t("ERROR.CONFIG_DUPLICATE_PROVIDER", { index: i, name: p.name }),
      );
    }
    seen.add(p.name);
  }

  const checkAdjustment = (path: string, adj: unknown): void => {
    if (adj === undefined || typeof adj !== "object" || adj === null) return;
    if (!("default" in adj)) {
      errors.push(t("ERROR.CONFIG_PRICE_ADJUSTMENT_NEEDS_DEFAULT", { path }));
    }
    for (const [key, val] of Object.entries(adj)) {
      if (typeof val !== "number") continue;
      // Text-type keys (vendors + default) must stay below 1.
      if (!NON_TEXT_TYPES.has(key) && val >= 1) {
        errors.push(
          t("ERROR.CONFIG_PRICE_ADJUSTMENT_TEXT_LIMIT", { path, key }),
        );
      }
    }
  };

  for (const [i, p] of config.providers.entries()) {
    checkAdjustment(`providers.${i}.priceAdjustment`, p.priceAdjustment);
  }

  for (const [i, p] of config.providers.entries()) {
    if (
      p.type === "sub2api" &&
      !p.adminApiKey &&
      (!p.groups || p.groups.length === 0)
    ) {
      errors.push(t("ERROR.CONFIG_SUB2API_REQUIRES_KEY", { index: i }));
    }
  }

  return errors;
}

// ─── Loader ────────────────────────────────────────────────────────────────

const CONFIG_CANDIDATES = [
  join(configDir(), "config.yml"),
  join(configDir(), "config.yaml"),
];

function formatTypeBoxErrors(schema: TSchema, value: unknown): string {
  const errors = [...Value.Errors(schema, value)].map(
    (e) => `${e.path || "root"}: ${e.message}`,
  );
  return errors.join("\n");
}

export async function loadConfig(path?: string): Promise<RuntimeConfig> {
  let resolvedPath = path;
  if (!resolvedPath) {
    for (const candidate of CONFIG_CANDIDATES) {
      if (await Bun.file(candidate).exists()) {
        resolvedPath = candidate;
        break;
      }
    }
    if (!resolvedPath) {
      throw new Error(
        t("ERROR.CONFIG_NO_FILE_FOUND", {
          tried: CONFIG_CANDIDATES.join(", "),
        }),
      );
    }
  }

  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    throw new Error(t("ERROR.CONFIG_FILE_NOT_FOUND", { path: resolvedPath }));
  }

  let parsedRaw: unknown;
  try {
    const text = expandEnvVars(await file.text());
    parsedRaw = Bun.YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      t("ERROR.CONFIG_INVALID_YAML", { path: resolvedPath, detail }),
    );
  }

  if (!Value.Check(ConfigSchema, parsedRaw)) {
    throw new Error(
      t("ERROR.CONFIG_VALIDATION_FAILED", {
        detail: formatTypeBoxErrors(ConfigSchema, parsedRaw),
      }),
    );
  }

  const typed = parsedRaw as ConfigSchemaType;
  const customErrors = customValidateConfig(typed);
  if (customErrors.length > 0) {
    throw new Error(
      t("ERROR.CONFIG_VALIDATION_FAILED", {
        detail: customErrors.join("\n"),
      }),
    );
  }

  const providers = typed.providers.map((p) => {
    if (p.type === "nvidia") {
      return {
        ...p,
        baseUrl: p.baseUrl ?? "https://integrate.api.nvidia.com",
        imageBaseUrl: p.imageBaseUrl ?? "https://ai.api.nvidia.com",
        ratio: p.ratio ?? 1,
      };
    }
    if (p.type === "openrouter") {
      return {
        ...p,
        baseUrl: p.baseUrl ?? "https://openrouter.ai/api",
        ratio: p.ratio ?? 0,
      };
    }
    return p;
  });

  // blacklist: union (builtin + global + typed). modelMapping: global wins on collision (user directive).
  const global = await loadGlobalConfig();
  const mergedBlacklist = [
    ...new Set([
      ...BUILTIN_BLACKLIST,
      ...(global.blacklist ?? []),
      ...(typed.blacklist ?? []),
    ]),
  ];
  // Values lowercase (toBareName produces lowercase). Keys without `/` lowercased too. Keys with `/` are upstream IDs left as-is.
  const mergedMapping: Record<string, string> = {};
  for (const [k, v] of [
    ...Object.entries(typed.modelMapping ?? {}),
    ...Object.entries(global.modelMapping ?? {}),
  ]) {
    const normalizedKey = k.includes("/") ? k : k.toLowerCase();
    mergedMapping[normalizedKey] = v.toLowerCase();
  }

  return {
    ...typed,
    providers,
    skipUnprofitableText:
      typed.skipUnprofitableText ?? CONFIG_DEFAULTS.skipUnprofitableText,
    globalConcurrency:
      typed.globalConcurrency ?? CONFIG_DEFAULTS.globalConcurrency,
    perUpstreamConcurrency:
      typed.perUpstreamConcurrency ?? CONFIG_DEFAULTS.perUpstreamConcurrency,
    blacklist: mergedBlacklist,
    modelMapping: mergedMapping,
  };
}

/** Returns the effective set of model types to test for a provider.
 * Provider-level overrides global; default is text-only.
 * Empty array means skip all testing. */
export function getTestModelTypes(
  config: RuntimeConfig,
  provider: AnyProviderConfig,
): Set<ModelType> {
  const types = provider.testModelTypes ?? config.testModelTypes;
  if (types !== undefined) return new Set(types as ModelType[]);
  return new Set<ModelType>(["text"]);
}

export function applyOnlyProviders(
  config: RuntimeConfig,
  onlyNames: string[],
): RuntimeConfig {
  if (onlyNames.length === 0) return config;

  const normalized = onlyNames
    .flatMap((name) => name.split(","))
    .map((name) => name.trim())
    .filter(Boolean);

  if (normalized.length === 0) return config;

  const available = new Set(config.providers.map((p) => p.name));
  const unknown = normalized.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(
      t("ERROR.CONFIG_UNKNOWN_PROVIDERS", {
        unknown: unknown.join(", "),
        available: [...available].join(", "),
      }),
    );
  }

  const onlySet = new Set(normalized);
  return {
    ...config,
    providers: config.providers.filter((p) => onlySet.has(p.name)),
    onlyProviders: onlySet,
  };
}

export function applyModelFilter(
  config: RuntimeConfig,
  raw: string[],
): RuntimeConfig {
  if (raw.length === 0) return config;

  const normalized = raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (normalized.length === 0) return config;

  return { ...config, modelFilter: normalized };
}
