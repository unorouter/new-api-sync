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

// Opaque per-model client hints, serialized to the models.metadata JSON column
// in new-api. Consumed by client UIs (e.g. unorouter) to pick model-specific
// behaviors like bumping max_tokens for thinking models.
const ModelMetadataSchema = T.Object({
  maxOutputTokens: T.Optional(T.Integer({ minimum: 1 })),
  isReasoning: T.Optional(T.Boolean()),
  /** Maximum number of reference images the model accepts in a single
   *  request. 6 means the model can compose a 5-character + 1-background
   *  scene (Matic's RP workload). Surfaced in unorouter so the UI can show
   *  a "6 refs" badge and gate uploads. */
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

// Common provider fields — extended by each provider variant below.
const ProviderCommonProps = {
  name: str,
  testModelTypes: T.Optional(T.Array(ModelTypeEnum)),
  enabledVendors: T.Optional(T.Array(str)),
  enabledModels: T.Optional(T.Array(EnabledModelEntrySchema)),
  priceAdjustment: T.Optional(PriceAdjustmentSchema),
  /** Per-provider override of perUpstreamConcurrency. Caps simultaneous
   *  test/probe HTTP requests against this provider's baseUrl. */
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

// ComfyUI: hand-defined channel that runs ComfyUI workflows behind any of the
// supported provider strategies (fal/replicate/runcomfy/runpod/native). There
// is no upstream catalog to discover; the channel exposes one model per key
// in `templates`. The whole `templates` block is serialized into the channel's
// workflow_templates JSON column, the new-api adapter parses it at request
// time.
const ComfyUiTemplateSchema = T.Object(
  {
    description: T.Optional(str),
    version: T.Optional(str),
    workflow: T.Any(),
    params: T.Optional(T.Record(str, T.Any())),
    lora_chain: T.Optional(T.Any()),
    /** Per-call price in USD, set via the new-api ModelPrice option on each
     *  sync. Required so we never accidentally serve a comfyui model for free
     *  if the operator forgot to configure it in the admin UI. */
    price: T.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);

const ComfyUiProviderSchema = T.Object({
  type: T.Literal("comfyui"),
  ...ProviderCommonProps,
  /** Provider strategy id used by the new-api adapter. v1 only "fal" is
   *  wired; runcomfy/replicate/runpod/native follow the same shape. */
  provider: T.Optional(
    T.Union([
      T.Literal("fal"),
      T.Literal("replicate"),
      T.Literal("runcomfy"),
      T.Literal("runpod"),
      T.Literal("native"),
    ]),
  ),
  baseUrl: T.Optional(T.String({ format: "uri" })),
  apiKey: str,
  /** Provider-specific endpoint id used by the new-api adapter when
   *  building the upstream submit URL. For RunPod this is the serverless
   *  endpoint id (e.g. "8genwa70xbaln4"); for fal it's the app slug
   *  ("fal-ai/comfy-server"). Stored in the workflow_templates JSON. */
  app: T.Optional(str),
  /** Channel display name + group on the target. Defaults to provider name. */
  channelName: T.Optional(str),
  /** Override channel tag; defaults to provider name. */
  channelTag: T.Optional(str),
  /** Map of model name -> ComfyUI workflow template. Each key becomes an
   *  exposed model on the channel. */
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
// Runtime types have defaults applied for `ratio` and the nvidia URLs.
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
  /** Top-level cap on simultaneous in-flight HTTP test/probe requests across
   *  the whole sync run. Default 20. */
  globalConcurrency: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
  /** Default cap on simultaneous in-flight requests per upstream baseUrl
   *  (overridable per provider). Default 5. */
  perUpstreamConcurrency: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
  blacklist: T.Optional(T.Array(str)),
  modelMapping: T.Optional(T.Record(T.String(), T.String())),
  providers: T.Array(AnyProviderSchema, { minItems: 1 }),
});

export type ConfigSchemaType = Static<typeof ConfigSchema>;
