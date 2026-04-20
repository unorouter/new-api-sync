import { FormatRegistry, Type as T, type Static } from "@sinclair/typebox";

// Register the "uri" format so T.String({ format: "uri" }) works at runtime.
FormatRegistry.Set("uri", (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});

const str = T.String({ minLength: 1 });

// Bare number applies to all model types uniformly, so must stay below 1 to
// avoid unprofitable text channels.
const PriceAdjustmentNumberSchema = T.Number({
  exclusiveMinimum: -1,
  exclusiveMaximum: 1,
});

// Per-key value in a priceAdjustment object. Non-text keys can be up to 1;
// text-type keys are checked with a custom validator (see core/config.ts).
const PriceAdjustmentValueSchema = T.Number({
  exclusiveMinimum: -1,
  maximum: 1,
});

const PriceAdjustmentObjectSchema = T.Record(
  T.String(),
  PriceAdjustmentValueSchema,
);

const PriceAdjustmentSchema = T.Union([
  PriceAdjustmentNumberSchema,
  PriceAdjustmentObjectSchema,
]);

const GridPricingRowSchema = T.Record(
  T.String(),
  T.Union([T.String(), T.Number()]),
);

const ModelPricingDetailSchema = T.Object({
  type: str,
  model: str,
  modelPricingGrid: T.Array(GridPricingRowSchema, { minItems: 1 }),
});

export const EnabledModelEntrySchema = T.Union([str, ModelPricingDetailSchema]);

export const ModelTypeEnum = T.Union([
  T.Literal("text"),
  T.Literal("image"),
  T.Literal("video"),
  T.Literal("audio"),
  T.Literal("embedding"),
]);

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

export const Sub2ApiGroupSchema = T.Object({
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

const OpenRouterProviderSchema = T.Object({
  type: T.Literal("openrouter"),
  ...ProviderCommonProps,
  baseUrl: T.Optional(T.String({ format: "uri" })),
  apiKey: str,
  models: T.Optional(T.Array(str)),
  ratio: T.Optional(T.Number({ minimum: 0 })),
});

export const AnyProviderSchema = T.Union([
  NewApiProviderSchema,
  Sub2ApiProviderSchema,
  DirectProviderSchema,
  NvidiaProviderSchema,
  OpenRouterProviderSchema,
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
export type OpenRouterProviderConfig = Static<
  typeof OpenRouterProviderSchema
> & {
  baseUrl: string;
  ratio: number;
};
export type AnyProviderConfig =
  | ProviderConfig
  | Sub2ApiProviderConfig
  | DirectProviderConfig
  | NvidiaProviderConfig
  | OpenRouterProviderConfig;
export type EnabledModelEntry = Static<typeof EnabledModelEntrySchema>;

export const LocaleEnum = T.Union([T.Literal("en"), T.Literal("zh")]);
export type LocaleValue = Static<typeof LocaleEnum>;

export const ThemeEnum = T.Union([
  T.Literal("light"),
  T.Literal("dark"),
  T.Literal("system"),
]);
export type ThemeValue = Static<typeof ThemeEnum>;

export const MainTabEnum = T.Union([
  T.Literal("dashboard"),
  T.Literal("config"),
  T.Literal("history"),
]);
export const HistoryTabEnum = T.Union([T.Literal("runs"), T.Literal("kiro")]);
export const RunResultFilterEnum = T.Union([
  T.Literal("all"),
  T.Literal("passed"),
  T.Literal("failed"),
]);
export const PipelineModeEnum = T.Union([
  T.Literal("run"),
  T.Literal("test"),
  T.Literal("reset"),
]);

export type MainTabValue = Static<typeof MainTabEnum>;
export type HistoryTabValue = Static<typeof HistoryTabEnum>;
export type RunResultFilterValue = Static<typeof RunResultFilterEnum>;
export type PipelineModeValue = Static<typeof PipelineModeEnum>;

/**
 * Cross-config settings that live in `config.global.yml`. All fields optional —
 * missing file is treated as an empty object. Locale/theme are global-only
 * (scalar, global wins). blacklist/modelMapping merge with per-config values
 * inside `loadConfig()`.
 */
export const GlobalConfigSchema = T.Object({
  locale: T.Optional(LocaleEnum),
  theme: T.Optional(ThemeEnum),
  mainTab: T.Optional(MainTabEnum),
  historyTab: T.Optional(HistoryTabEnum),
  selectedRunId: T.Optional(T.Union([T.String(), T.Null()])),
  runResultFilter: T.Optional(RunResultFilterEnum),
  runQuery: T.Optional(T.String()),
  kiroQuery: T.Optional(T.String()),
  selectedConfigName: T.Optional(T.String()),
  pipelineMode: T.Optional(PipelineModeEnum),
  onlyProviders: T.Optional(T.Record(T.String(), T.Array(T.String()))),
  modelFilter: T.Optional(T.Record(T.String(), T.String())),
  blacklist: T.Optional(T.Array(str)),
  modelMapping: T.Optional(T.Record(T.String(), T.String())),
});
export type GlobalConfigType = Static<typeof GlobalConfigSchema>;

export const ConfigSchema = T.Object({
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

export type ConfigSchemaType = Static<typeof ConfigSchema>;
