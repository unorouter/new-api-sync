import { FormatRegistry, Type as T, type Static } from "@sinclair/typebox";

FormatRegistry.Set("uri", (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});

const str = T.String({ minLength: 1 });

/** Bare number applies uniformly; must stay < 1 to avoid unprofitable text channels. */
const PriceAdjustmentNumberSchema = T.Number({
  exclusiveMinimum: -1,
  exclusiveMaximum: 1,
});

/** Per-key: non-text up to 1, text-type checked in customValidateConfig. */
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

/** Serialized to models.metadata; consumed by client UIs (unorouter). */
const ModelMetadataSchema = T.Object({
  maxOutputTokens: T.Optional(T.Integer({ minimum: 1 })),
  isReasoning: T.Optional(T.Boolean()),
  /** 6 = 5 chars + 1 bg compose; UI gates uploads. */
  maxImageInputs: T.Optional(T.Integer({ minimum: 1 })),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

const ModelPricingDetailSchema = T.Object({
  type: str,
  model: str,
  modelPricingGrid: T.Array(GridPricingRowSchema, { minItems: 1 }),
  metadata: T.Optional(ModelMetadataSchema),
});

const ModelSettingsDetailSchema = T.Object({
  model: str,
  metadata: T.Optional(ModelMetadataSchema),
});

const EnabledModelEntrySchema = T.Union([
  str,
  ModelPricingDetailSchema,
  ModelSettingsDetailSchema,
]);

const ModelTypeEnum = T.Union([
  T.Literal("text"),
  T.Literal("image"),
  T.Literal("video"),
  T.Literal("audio"),
  T.Literal("embedding"),
]);

/** Shared across provider variants. */
const ProviderCommonProps = {
  name: str,
  testModelTypes: T.Optional(T.Array(ModelTypeEnum)),
  enabledVendors: T.Optional(T.Array(str)),
  enabledModels: T.Optional(T.Array(EnabledModelEntrySchema)),
  priceAdjustment: T.Optional(PriceAdjustmentSchema),
  perUpstreamConcurrency: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
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

// ComfyUI: hand-defined channel; templates block serializes to workflow_templates.
const ComfyUiTemplateSchema = T.Object(
  {
    description: T.Optional(str),
    version: T.Optional(str),
    workflow: T.Any(),
    params: T.Optional(T.Record(str, T.Any())),
    lora_chain: T.Optional(T.Any()),
    /** Required so we never serve a comfyui model for free by accident. */
    price: T.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);

const ComfyUiProviderSchema = T.Object({
  type: T.Literal("comfyui"),
  ...ProviderCommonProps,
  /** v1 wires only "fal"; others follow the same shape. */
  provider: T.Union([
    T.Literal("fal"),
    T.Literal("replicate"),
    T.Literal("runcomfy"),
    T.Literal("runpod"),
    T.Literal("native"),
  ]),
  baseUrl: T.String({ format: "uri" }),
  apiKey: str,
  /** RunPod serverless endpoint id / fal app slug. */
  app: T.Optional(str),
  channelName: T.Optional(str),
  channelTag: T.Optional(str),
  templates: T.Record(str, ComfyUiTemplateSchema),
});

const AnyProviderSchema = T.Union([
  NewApiProviderSchema,
  Sub2ApiProviderSchema,
  NvidiaProviderSchema,
  OpenRouterProviderSchema,
  ComfyUiProviderSchema,
]);

export type ProviderConfig = Static<typeof NewApiProviderSchema>;
export type Sub2ApiProviderConfig = Static<typeof Sub2ApiProviderSchema>;
// Runtime: ratio and nvidia URLs filled in by loader.
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
export type ComfyUiProviderConfig = Static<typeof ComfyUiProviderSchema>;
export type AnyProviderConfig =
  | ProviderConfig
  | Sub2ApiProviderConfig
  | NvidiaProviderConfig
  | OpenRouterProviderConfig
  | ComfyUiProviderConfig;
export type EnabledModelEntry = Static<typeof EnabledModelEntrySchema>;

const LocaleEnum = T.Union([T.Literal("en"), T.Literal("zh")]);
export type LocaleValue = Static<typeof LocaleEnum>;

const ThemeEnum = T.Union([
  T.Literal("light"),
  T.Literal("dark"),
  T.Literal("system"),
]);
export type ThemeValue = Static<typeof ThemeEnum>;

const MainTabEnum = T.Union([
  T.Literal("dashboard"),
  T.Literal("config"),
  T.Literal("history"),
]);
const HistoryTabEnum = T.Union([
  T.Literal("runs"),
  T.Literal("authenticity"),
]);
const RunResultFilterEnum = T.Union([
  T.Literal("all"),
  T.Literal("passed"),
  T.Literal("failed"),
]);
const PipelineModeEnum = T.Union([
  T.Literal("run"),
  T.Literal("reset"),
]);

export type MainTabValue = Static<typeof MainTabEnum>;
export type HistoryTabValue = Static<typeof HistoryTabEnum>;
export type RunResultFilterValue = Static<typeof RunResultFilterEnum>;
export type PipelineModeValue = Static<typeof PipelineModeEnum>;

/** config.global.yml. All optional. Scalars are global-only; blacklist/modelMapping merge in loadConfig. */
export const GlobalConfigSchema = T.Object({
  locale: T.Optional(LocaleEnum),
  theme: T.Optional(ThemeEnum),
  mainTab: T.Optional(MainTabEnum),
  historyTab: T.Optional(HistoryTabEnum),
  selectedRunId: T.Optional(T.Union([T.String(), T.Null()])),
  runResultFilter: T.Optional(RunResultFilterEnum),
  runQuery: T.Optional(T.String()),
  authenticityQuery: T.Optional(T.String()),
  selectedConfigName: T.Optional(T.String()),
  pipelineMode: T.Optional(PipelineModeEnum),
  verbose: T.Optional(T.Boolean()),
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
  /** Default 20. */
  globalConcurrency: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
  /** Default 5; overridable per provider. */
  perUpstreamConcurrency: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
  blacklist: T.Optional(T.Array(str)),
  modelMapping: T.Optional(T.Record(T.String(), T.String())),
  providers: T.Array(AnyProviderSchema, { minItems: 1 }),
});

export type ConfigSchemaType = Static<typeof ConfigSchema>;
