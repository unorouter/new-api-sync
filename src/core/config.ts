import { loadGlobalConfig } from "@core/global-config";
import { MODEL_TYPES, type ModelType } from "@core/models/types";
import {
  ConfigSchema,
  type AnyProviderConfig,
  type ConfigSchemaType,
  type EnabledModelEntry,
} from "@core/validations/config";
import { t } from "@server/i18n";
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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
    if (typeof entry !== "string" && entry.modelPricingGrid) {
      result[entry.model] = entry.modelPricingGrid;
    }
  }
  return result;
}

// Defaults applied post-parse to match the previous Zod .default() semantics.
export interface RuntimeConfig extends Omit<
  ConfigSchemaType,
  "blacklist" | "modelMapping" | "skipUnprofitableText" | "providers"
> {
  providers: AnyProviderConfig[];
  skipUnprofitableText: boolean;
  blacklist: string[];
  modelMapping: Record<string, string>;
  onlyProviders?: Set<string>;
  modelFilter?: string[];
  isTestMode?: boolean;
}

// ============ Validation helpers ============

/**
 * Custom cross-field rules that TypeBox's schema cannot express directly.
 * Returns an array of error messages (empty = valid).
 */
export function customValidateConfig(config: ConfigSchemaType): string[] {
  const errors: string[] = [];

  // Duplicate provider names
  const seen = new Set<string>();
  for (const [i, p] of config.providers.entries()) {
    if (seen.has(p.name)) {
      errors.push(`providers.${i}.name: duplicate provider name: ${p.name}`);
    }
    seen.add(p.name);
  }

  // priceAdjustment object rules (applies to both top-level and per-provider)
  const checkAdjustment = (path: string, adj: unknown): void => {
    if (adj === undefined || typeof adj !== "object" || adj === null) return;
    if (!("default" in adj)) {
      errors.push(`${path}: priceAdjustment object must contain a default key`);
    }
    for (const [key, val] of Object.entries(adj)) {
      if (typeof val !== "number") continue;
      // Text-type keys (vendors + default) must stay below 1
      if (!NON_TEXT_TYPES.has(key) && val >= 1) {
        errors.push(
          `${path}.${key}: priceAdjustment values for text types (vendors/default) must be < 1; only non-text types (image, video, audio, embedding) can be >= 1`,
        );
      }
    }
  };

  for (const [i, p] of config.providers.entries()) {
    checkAdjustment(`providers.${i}.priceAdjustment`, p.priceAdjustment);
  }

  // sub2api must have adminApiKey or groups
  for (const [i, p] of config.providers.entries()) {
    if (
      p.type === "sub2api" &&
      !p.adminApiKey &&
      (!p.groups || p.groups.length === 0)
    ) {
      errors.push(
        `providers.${i}: sub2api provider requires adminApiKey or groups`,
      );
    }
  }

  return errors;
}

// ============ Loader ============

const CONFIG_CANDIDATES = ["./config.yml", "./config.yaml"];

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
    parsedRaw = Bun.YAML.parse(await file.text());
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

  // Apply provider-level defaults that Zod's .default() used to handle
  const providers = typed.providers.map((p) => {
    if (p.type === "direct") {
      return { ...p, ratio: p.ratio ?? 1 };
    }
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
        baseUrl: p.baseUrl ?? "https://openrouter.ai/api/v1",
        ratio: p.ratio ?? 0,
      };
    }
    return p;
  });

  // Merge in cross-config settings from `config.global.yml`. Missing file is
  // treated as empty. For `blacklist` we union+dedupe; for `modelMapping` we
  // let global win on key collisions (per user's "global wins" directive).
  const global = await loadGlobalConfig();
  const mergedBlacklist = [
    ...new Set([...(global.blacklist ?? []), ...(typed.blacklist ?? [])]),
  ];
  const mergedMapping: Record<string, string> = {
    ...(typed.modelMapping ?? {}),
    ...(global.modelMapping ?? {}),
  };

  return {
    ...typed,
    providers,
    skipUnprofitableText: typed.skipUnprofitableText ?? true,
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
