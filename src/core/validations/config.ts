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
const uri = T.String({ format: "uri" });
const Opt = T.Optional;

const PriceAdjustmentSchema = T.Union([
  T.Number({ exclusiveMinimum: -1, exclusiveMaximum: 1 }),
  T.Record(T.String(), T.Number({ exclusiveMinimum: -1, maximum: 1 })),
]);

const GridPricingRowSchema = T.Record(
  T.String(),
  T.Union([T.String(), T.Number()]),
);

const ModelMetadataSchema = T.Object({
  maxOutputTokens: Opt(T.Integer({ minimum: 1 })),
  isReasoning: Opt(T.Boolean()),
  maxImageInputs: Opt(T.Integer({ minimum: 1 })),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

const EnabledModelEntrySchema = T.Union([
  str,
  T.Object({
    type: str,
    model: str,
    modelPricingGrid: T.Array(GridPricingRowSchema, { minItems: 1 }),
    metadata: Opt(ModelMetadataSchema),
  }),
  T.Object({ model: str, metadata: Opt(ModelMetadataSchema) }),
]);

const ModelTypeEnum = T.Union([
  T.Literal("text"),
  T.Literal("image"),
  T.Literal("video"),
  T.Literal("audio"),
  T.Literal("embedding"),
]);

const ProviderCommonProps = {
  name: str,
  testModelTypes: Opt(T.Array(ModelTypeEnum)),
  enabledVendors: Opt(T.Array(str)),
  enabledModels: Opt(T.Array(EnabledModelEntrySchema)),
  priceAdjustment: Opt(PriceAdjustmentSchema),
  perUpstreamConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })),
} as const;

const NewApiProviderSchema = T.Object({
  type: T.Literal("newapi"),
  ...ProviderCommonProps,
  baseUrl: uri,
  systemAccessToken: str,
  userId: T.Integer({ minimum: 1 }),
});
const Sub2ApiProviderSchema = T.Object({
  type: T.Literal("sub2api"),
  ...ProviderCommonProps,
  baseUrl: uri,
  adminApiKey: Opt(str),
  groups: Opt(
    T.Array(T.Object({ key: str, platform: str, name: Opt(str) }), {
      minItems: 1,
    }),
  ),
});
const NvidiaProviderSchema = T.Object({
  type: T.Literal("nvidia"),
  ...ProviderCommonProps,
  baseUrl: Opt(uri),
  imageBaseUrl: Opt(uri),
  apiKey: str,
  models: Opt(T.Array(str)),
  ratio: Opt(T.Number({ exclusiveMinimum: 0 })),
});
const OpenRouterProviderSchema = T.Object({
  type: T.Literal("openrouter"),
  ...ProviderCommonProps,
  baseUrl: Opt(uri),
  apiKey: str,
  models: Opt(T.Array(str)),
  ratio: Opt(T.Number({ minimum: 0 })),
});
const ComfyUiTemplateSchema = T.Object(
  {
    description: Opt(str),
    version: Opt(str),
    workflow: T.Any(),
    params: Opt(T.Record(str, T.Any())),
    lora_chain: Opt(T.Any()),
    price: T.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);
const ComfyUiProviderSchema = T.Object({
  type: T.Literal("comfyui"),
  ...ProviderCommonProps,
  provider: T.Union([
    T.Literal("fal"),
    T.Literal("replicate"),
    T.Literal("runcomfy"),
    T.Literal("runpod"),
    T.Literal("native"),
  ]),
  baseUrl: uri,
  apiKey: str,
  app: Opt(str),
  channelName: Opt(str),
  channelTag: Opt(str),
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
const ThemeEnum = T.Union([
  T.Literal("light"),
  T.Literal("dark"),
  T.Literal("system"),
]);
const MainTabEnum = T.Union([
  T.Literal("dashboard"),
  T.Literal("config"),
  T.Literal("history"),
]);
const HistoryTabEnum = T.Union([T.Literal("runs"), T.Literal("authenticity")]);
const RunResultFilterEnum = T.Union([
  T.Literal("all"),
  T.Literal("passed"),
  T.Literal("failed"),
]);
const PipelineModeEnum = T.Union([T.Literal("run"), T.Literal("reset")]);

export type LocaleValue = Static<typeof LocaleEnum>;
export type ThemeValue = Static<typeof ThemeEnum>;
export type MainTabValue = Static<typeof MainTabEnum>;
export type HistoryTabValue = Static<typeof HistoryTabEnum>;
export type RunResultFilterValue = Static<typeof RunResultFilterEnum>;
export type PipelineModeValue = Static<typeof PipelineModeEnum>;

export const GlobalConfigSchema = T.Object({
  locale: Opt(LocaleEnum),
  theme: Opt(ThemeEnum),
  mainTab: Opt(MainTabEnum),
  historyTab: Opt(HistoryTabEnum),
  selectedRunId: Opt(T.Union([T.String(), T.Null()])),
  runResultFilter: Opt(RunResultFilterEnum),
  runQuery: Opt(T.String()),
  authenticityQuery: Opt(T.String()),
  selectedConfigName: Opt(T.String()),
  pipelineMode: Opt(PipelineModeEnum),
  verbose: Opt(T.Boolean()),
  onlyProviders: Opt(T.Record(T.String(), T.Array(T.String()))),
  modelFilter: Opt(T.Record(T.String(), T.String())),
  blacklist: Opt(T.Array(str)),
  modelMapping: Opt(T.Record(T.String(), T.String())),
});
export type GlobalConfigType = Static<typeof GlobalConfigSchema>;

export const ConfigSchema = T.Object({
  target: T.Object({
    baseUrl: uri,
    systemAccessToken: str,
    userId: T.Integer({ minimum: 1 }),
    targetPrefix: Opt(str),
  }),
  testModelTypes: Opt(T.Array(ModelTypeEnum)),
  skipUnprofitableText: Opt(T.Boolean()),
  globalConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })),
  perUpstreamConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })),
  blacklist: Opt(T.Array(str)),
  modelMapping: Opt(T.Record(T.String(), T.String())),
  providers: T.Array(AnyProviderSchema, { minItems: 1 }),
});

export type ConfigSchemaType = Static<typeof ConfigSchema>;
