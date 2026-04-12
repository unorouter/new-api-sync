import { MODEL_TYPES, type ModelType } from "@core/lib/constants";
import {
  FormatRegistry,
  Type as T,
  type Static,
  type TSchema,
} from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Register the "uri" format so T.String({ format: "uri" }) works at runtime.
FormatRegistry.Set("uri", (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});

// ============ Schema ============

const str = T.String({ minLength: 1 });

const NON_TEXT_TYPES: Set<string> = new Set(MODEL_TYPES.filter((t) => t !== "text"));

// Bare number applies to all model types uniformly, so must stay below 1 to
// avoid unprofitable text channels.
const PriceAdjustmentNumberSchema = T.Number({ exclusiveMinimum: -1, exclusiveMaximum: 1 });

// Per-key value in a priceAdjustment object. Non-text keys can be up to 1;
// text-type keys are checked below with a custom validator.
const PriceAdjustmentValueSchema = T.Number({ exclusiveMinimum: -1, maximum: 1 });

const PriceAdjustmentObjectSchema = T.Record(T.String(), PriceAdjustmentValueSchema);

const PriceAdjustmentSchema = T.Union([
  PriceAdjustmentNumberSchema,
  PriceAdjustmentObjectSchema,
]);

const GridPricingRowSchema = T.Record(T.String(), T.Union([T.String(), T.Number()]));

const ModelPricingDetailSchema = T.Object({
  type: str,
  model: str,
  modelPricingGrid: T.Array(GridPricingRowSchema, { minItems: 1 }),
});

const EnabledModelEntrySchema = T.Union([str, ModelPricingDetailSchema]);

const ModelTypeEnum = T.Union(MODEL_TYPES.map((t) => T.Literal(t)));

// Common provider fields — extended by each provider variant below.
const ProviderCommonProps = {
  name: str,
  testModelTypes: T.Optional(T.Array(ModelTypeEnum)),
  enabledVendors: T.Optional(T.Array(str)),
  enabledModels: T.Optional(T.Array(EnabledModelEntrySchema)),
  priceAdjustment: T.Optional(PriceAdjustmentSchema),
} as const;

const NewApiProviderSchema = T.Object({
  type: T.Literal("newapi"),
  ...ProviderCommonProps,
  baseUrl: T.String({ format: "uri" }),
  systemAccessToken: str,
  userId: T.Integer({ minimum: 1 }),
});

const Sub2ApiGroupSchema = T.Object({
  key: str,
  platform: str,
  name: T.Optional(str),
});

const Sub2ApiProviderSchema = T.Object({
  type: T.Literal("sub2api"),
  ...ProviderCommonProps,
  baseUrl: T.String({ format: "uri" }),
  adminApiKey: T.Optional(str),
  groups: T.Optional(T.Array(Sub2ApiGroupSchema, { minItems: 1 })),
});

const DirectProviderSchema = T.Object({
  type: T.Literal("direct"),
  ...ProviderCommonProps,
  baseUrl: T.String({ format: "uri" }),
  apiKey: str,
  vendor: str,
  models: T.Optional(T.Array(str, { minItems: 1 })),
  channelType: T.Optional(T.Integer({ minimum: 1 })),
  ratio: T.Optional(T.Number({ exclusiveMinimum: 0 })),
  discoverEndpoint: T.Optional(str),
});

const NvidiaProviderSchema = T.Object({
  type: T.Literal("nvidia"),
  ...ProviderCommonProps,
  baseUrl: T.Optional(T.String({ format: "uri" })),
  imageBaseUrl: T.Optional(T.String({ format: "uri" })),
  apiKey: str,
  models: T.Optional(T.Array(str)),
  ratio: T.Optional(T.Number({ exclusiveMinimum: 0 })),
});

const AnyProviderSchema = T.Union([
  NewApiProviderSchema,
  Sub2ApiProviderSchema,
  DirectProviderSchema,
  NvidiaProviderSchema,
]);

export type ProviderConfig = Static<typeof NewApiProviderSchema>;
export type Sub2ApiProviderConfig = Static<typeof Sub2ApiProviderSchema>;
// Runtime types have defaults applied for `ratio` and the nvidia URLs.
export type DirectProviderConfig = Static<typeof DirectProviderSchema> & {
  ratio: number;
};
export type NvidiaProviderConfig = Static<typeof NvidiaProviderSchema> & {
  baseUrl: string;
  imageBaseUrl: string;
  ratio: number;
};
export type AnyProviderConfig =
  | ProviderConfig
  | Sub2ApiProviderConfig
  | DirectProviderConfig
  | NvidiaProviderConfig;
export type EnabledModelEntry = Static<typeof EnabledModelEntrySchema>;

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

const ConfigSchema = T.Object({
  target: T.Object({
    baseUrl: T.String({ format: "uri" }),
    systemAccessToken: str,
    userId: T.Integer({ minimum: 1 }),
    targetPrefix: T.Optional(str),
  }),
  testModelTypes: T.Optional(T.Array(ModelTypeEnum)),
  skipUnprofitableText: T.Optional(T.Boolean()),
  blacklist: T.Optional(T.Array(str)),
  modelMapping: T.Optional(T.Record(T.String(), T.String())),
  providers: T.Array(AnyProviderSchema, { minItems: 1 }),
});

type ConfigSchemaType = Static<typeof ConfigSchema>;

// Defaults applied post-parse to match the previous Zod .default() semantics.
export interface RuntimeConfig
  extends Omit<
    ConfigSchemaType,
    "blacklist" | "modelMapping" | "skipUnprofitableText" | "providers"
  > {
  providers: AnyProviderConfig[];
  skipUnprofitableText: boolean;
  blacklist: string[];
  modelMapping: Record<string, string>;
  onlyProviders?: Set<string>;
  isTestMode?: boolean;
}

// ============ Validation helpers ============

/**
 * Custom cross-field rules that TypeBox's schema cannot express directly.
 * Returns an array of error messages (empty = valid).
 */
function customValidate(config: ConfigSchemaType): string[] {
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
    if (p.type === "sub2api" && !p.adminApiKey && (!p.groups || p.groups.length === 0)) {
      errors.push(`providers.${i}: sub2api provider requires adminApiKey or groups`);
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
        `No config file found (tried ${CONFIG_CANDIDATES.join(", ")})`,
      );
    }
  }

  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = Bun.YAML.parse(await file.text());
  } catch (error) {
    throw new Error(
      `Invalid YAML in ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Value.Check(ConfigSchema, parsedRaw)) {
    throw new Error(
      `Config validation failed:\n${formatTypeBoxErrors(ConfigSchema, parsedRaw)}`,
    );
  }

  const typed = parsedRaw as ConfigSchemaType;
  const customErrors = customValidate(typed);
  if (customErrors.length > 0) {
    throw new Error(`Config validation failed:\n${customErrors.join("\n")}`);
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
    return p;
  });

  return {
    ...typed,
    providers,
    skipUnprofitableText: typed.skipUnprofitableText ?? true,
    blacklist: typed.blacklist ?? [],
    modelMapping: typed.modelMapping ?? {},
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
      `Unknown provider(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
    );
  }

  const onlySet = new Set(normalized);
  return {
    ...config,
    providers: config.providers.filter((p) => onlySet.has(p.name)),
    onlyProviders: onlySet,
  };
}
