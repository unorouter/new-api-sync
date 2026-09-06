import type { ChannelParamOverrideRule } from "@core/pricing/param-override";
import { MODEL_TYPES, type ModelType } from "@core/types";
import {
  ConfigSchema,
  GlobalConfigSchema,
  type AnyProviderConfig,
  type ConfigSchemaType,
  type EnabledModelEntry,
  type GlobalConfigType,
  type SimpleFreeProviderConfig,
} from "@core/validations/config";
import { SIMPLE_PROVIDER_META_MAP } from "@core/vendors/registry-meta";
import { t } from "@server/i18n";
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";

export function configDir(): string {
  if (typeof process === "undefined") return "";
  const exeName = basename(process.execPath).toLowerCase();
  if (exeName === "bun" || exeName.startsWith("bun.")) return process.cwd();
  return dirname(process.execPath);
}

function expandEnvVars(text: string): string {
  if (typeof process === "undefined") return text;
  return text.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi,
    (m, name, fb) => {
      const v = process.env[name];
      return v !== undefined ? v : fb !== undefined ? fb : m;
    },
  );
}

export const GLOBAL_CONFIG_PATH = join(configDir(), "config.global.yml");

function formatTypeBoxErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .map((e) => `${e.path || "root"}: ${e.message}`)
    .join("\n");
}

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
  if (parsedRaw == null) return {};
  if (!Value.Check(GlobalConfigSchema, parsedRaw))
    throw new Error(
      t("ERROR.GLOBAL_CONFIG_VALIDATION_FAILED", {
        detail: formatTypeBoxErrors(GlobalConfigSchema, parsedRaw),
      }),
    );
  return parsedRaw as GlobalConfigType;
}

export async function writeGlobalConfig(next: GlobalConfigType): Promise<void> {
  await Bun.write(
    GLOBAL_CONFIG_PATH,
    YAML.stringify(next, { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE" }),
  );
}

const NON_TEXT_TYPES: Set<string> = new Set(
  MODEL_TYPES.filter((t) => t !== "text"),
);

export const getEnabledModelGlobs = (
  entries: EnabledModelEntry[] | undefined,
): string[] | undefined =>
  entries?.map((e) => (typeof e === "string" ? e : e.model));

function extractEnabledModelField<T>(
  entries: EnabledModelEntry[] | undefined,
  field: string,
): Record<string, T> {
  const result: Record<string, T> = {};
  if (!entries) return result;
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    const value = (entry as Record<string, unknown>)[field];
    if (value) result[entry.model] = value as T;
  }
  return result;
}

export const getPricingGridFromEnabledModels = (
  entries: EnabledModelEntry[] | undefined,
): Record<string, Record<string, string | number>[]> =>
  extractEnabledModelField(entries, "modelPricingGrid");

export const getMetadataFromEnabledModels = (
  entries: EnabledModelEntry[] | undefined,
): Record<string, Record<string, unknown>> =>
  extractEnabledModelField(entries, "metadata");

export const CONFIG_DEFAULTS = {
  skipUnprofitableText: true,
  globalConcurrency: 50,
  perUpstreamConcurrency: 5,
} as const;

// prettier-ignore
const BUILTIN_BLACKLIST: readonly string[] = ["ai-synthetic-video-detector","arctic-embed-l","bge-m3","devstral-2-123b-instruct-2512","embed-qa-4","gliner-pii","ising-calibration-1-35b-a3b","magistral-small-2506","ministral-14b-instruct-2512","mixtral-8x22b-instruct-v0.1","mixtral-8x7b-instruct-v0.1","nv-embed-v1","nv-embedcode-7b-v1","nv-embedqa-e5-v5","owl-alpha","phi-4-mini-instruct","phi-4-multimodal-instruct","riva-translate-4b-instruct-v1.1","sarvam-m","seed-oss-36b-instruct","solar-10.7b-instruct","step-3.5-flash","stockmark-2-100b-instruct"];

// prettier-ignore
type StripKeys = "blacklist" | "modelMapping" | "groupMapping" | "channelParamOverride" | "skipUnprofitableText" | "providers" | "globalConcurrency" | "perUpstreamConcurrency";

export interface RuntimeConfig extends Omit<ConfigSchemaType, StripKeys> {
  providers: AnyProviderConfig[];
  skipUnprofitableText: boolean;
  globalConcurrency: number;
  perUpstreamConcurrency: number;
  blacklist: string[];
  modelMapping: Record<string, string>;
  groupMapping: Record<string, string>;
  channelParamOverride: ChannelParamOverrideRule[];
  onlyProviders?: Set<string>;
  modelFilter?: string[];
  modelTypeFilter?: ModelType[];
  isTestMode?: boolean;
}

export function customValidateConfig(config: ConfigSchemaType): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [i, p] of config.providers.entries()) {
    if (seen.has(p.name))
      errors.push(
        t("ERROR.CONFIG_DUPLICATE_PROVIDER", { index: i, name: p.name }),
      );
    seen.add(p.name);

    const adj = "priceAdjustment" in p ? p.priceAdjustment : undefined;
    if (adj && typeof adj === "object") {
      const path = `providers.${i}.priceAdjustment`;
      if (!("default" in adj))
        errors.push(t("ERROR.CONFIG_PRICE_ADJUSTMENT_NEEDS_DEFAULT", { path }));
      for (const [key, val] of Object.entries(adj))
        if (typeof val === "number" && !NON_TEXT_TYPES.has(key) && val >= 1)
          errors.push(
            t("ERROR.CONFIG_PRICE_ADJUSTMENT_TEXT_LIMIT", { path, key }),
          );
    }
  }

  return errors;
}

const CONFIG_CANDIDATES = [
  join(configDir(), "config.yml"),
  join(configDir(), "config.yaml"),
];

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
  if (!(await file.exists()))
    throw new Error(t("ERROR.CONFIG_FILE_NOT_FOUND", { path: resolvedPath }));

  let parsedRaw: unknown;
  try {
    parsedRaw = Bun.YAML.parse(expandEnvVars(await file.text()));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      t("ERROR.CONFIG_INVALID_YAML", { path: resolvedPath, detail }),
    );
  }

  if (!Value.Check(ConfigSchema, parsedRaw))
    throw new Error(
      t("ERROR.CONFIG_VALIDATION_FAILED", {
        detail: formatTypeBoxErrors(ConfigSchema, parsedRaw),
      }),
    );

  const typed = parsedRaw as ConfigSchemaType;
  const customErrors = customValidateConfig(typed);
  if (customErrors.length > 0)
    throw new Error(
      t("ERROR.CONFIG_VALIDATION_FAILED", { detail: customErrors.join("\n") }),
    );

  const providers = typed.providers.map((p) => {
    if (p.type === "nvidia")
      return {
        ...p,
        baseUrl: p.baseUrl ?? "https://integrate.api.nvidia.com",
        imageBaseUrl: p.imageBaseUrl ?? "https://ai.api.nvidia.com",
        ratio: p.ratio ?? 1,
      };
    if (p.type === "openrouter")
      return {
        ...p,
        baseUrl: p.baseUrl ?? "https://openrouter.ai/api",
        ratio: p.ratio ?? 0,
      };
    const simple = SIMPLE_PROVIDER_META_MAP[p.type];
    if (simple) {
      const sp = p as SimpleFreeProviderConfig;
      return {
        ...sp,
        baseUrl: sp.baseUrl ?? simple.defaultBaseUrl,
        ratio: sp.ratio ?? simple.defaultRatio,
      };
    }
    return p;
  }) as AnyProviderConfig[];

  const global = await loadGlobalConfig();
  const mergedBlacklist = [
    ...new Set([
      ...BUILTIN_BLACKLIST,
      ...(global.blacklist ?? []),
      ...(typed.blacklist ?? []),
    ]),
  ];
  const mergedMapping: Record<string, string> = {};
  for (const [k, v] of [
    ...Object.entries(typed.modelMapping ?? {}),
    ...Object.entries(global.modelMapping ?? {}),
  ]) {
    mergedMapping[k.includes("/") ? k : k.toLowerCase()] = v.toLowerCase();
  }
  // Value stays verbatim: it is the public label's casing, the operator's call.
  const mergedGroupMapping: Record<string, string> = {};
  for (const [k, v] of [
    ...Object.entries(typed.groupMapping ?? {}),
    ...Object.entries(global.groupMapping ?? {}),
  ]) {
    mergedGroupMapping[k.toLowerCase()] = v;
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
    groupMapping: mergedGroupMapping,
    channelParamOverride: [
      ...(typed.channelParamOverride ?? []),
      ...(global.channelParamOverride ?? []),
    ],
  };
}

export function getTestModelTypes(
  config: RuntimeConfig,
  provider: AnyProviderConfig,
): Set<ModelType> {
  const types =
    ("testModelTypes" in provider ? provider.testModelTypes : undefined) ??
    config.testModelTypes;
  if (types !== undefined) return new Set(types as ModelType[]);
  return new Set<ModelType>(["text"]);
}

function normalizeCsv(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function applyOnlyProviders(
  config: RuntimeConfig,
  onlyNames: string[],
): RuntimeConfig {
  if (onlyNames.length === 0) return config;
  const normalized = normalizeCsv(onlyNames);
  if (normalized.length === 0) return config;

  const available = new Set(config.providers.map((p) => p.name));
  const unknown = normalized.filter((name) => !available.has(name));
  if (unknown.length > 0)
    throw new Error(
      t("ERROR.CONFIG_UNKNOWN_PROVIDERS", {
        unknown: unknown.join(", "),
        available: [...available].join(", "),
      }),
    );

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
  const normalized = normalizeCsv(raw);
  if (normalized.length === 0) return config;
  return { ...config, modelFilter: normalized };
}

// Scope a sync to model TYPES (image/video/audio/text/embedding) via inferModelType, instead of name
// globs. Sets partial-sync semantics (no orphan cleanup, out-of-scope preserved) like --models.
export function applyModelTypeFilter(
  config: RuntimeConfig,
  raw: string[],
): RuntimeConfig {
  if (raw.length === 0) return config;
  const normalized = normalizeCsv(raw).map((v) => v.toLowerCase());
  if (normalized.length === 0) return config;
  const valid = new Set<string>(MODEL_TYPES);
  const unknown = normalized.filter((t) => !valid.has(t));
  if (unknown.length > 0)
    throw new Error(
      t("ERROR.CONFIG_UNKNOWN_MODEL_TYPES", {
        unknown: unknown.join(", "),
        available: [...valid].join(", "),
      }),
    );
  return { ...config, modelTypeFilter: normalized as ModelType[] };
}
