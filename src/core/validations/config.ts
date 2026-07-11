import { FormatRegistry, Type as T, type Static } from "@sinclair/typebox";
import {
  SIMPLE_PROVIDER_META,
  type SimpleProviderKind,
} from "@core/vendors/registry-meta";

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

// prettier-ignore
const ModelMetadataSchema = T.Object({ maxOutputTokens: Opt(T.Integer({ minimum: 1 })), isReasoning: Opt(T.Boolean()), disableThinking: Opt(T.Boolean()), maxImageInputs: Opt(T.Integer({ minimum: 1 })), supportedParams: Opt(T.Array(str, { minItems: 1 })) });
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

const EnabledModelEntrySchema = T.Union([
  str,
  // prettier-ignore
  T.Object({ type: str, model: str, modelPricingGrid: T.Array(GridPricingRowSchema, { minItems: 1 }), metadata: Opt(ModelMetadataSchema) }),
  T.Object({ model: str, metadata: Opt(ModelMetadataSchema) }),
]);

// prettier-ignore
const ModelTypeEnum = T.Union([T.Literal("text"), T.Literal("image"), T.Literal("video"), T.Literal("audio"), T.Literal("embedding")]);

// prettier-ignore
const ProviderCommonProps = { name: str, testModelTypes: Opt(T.Array(ModelTypeEnum)), enabledVendors: Opt(T.Array(str)), enabledModels: Opt(T.Array(EnabledModelEntrySchema)), priceAdjustment: Opt(PriceAdjustmentSchema), perUpstreamConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })) } as const;

// prettier-ignore
const NewApiProviderSchema = T.Object({ type: T.Literal("newapi"), ...ProviderCommonProps, baseUrl: uri, systemAccessToken: str, userId: T.Integer({ minimum: 1 }) });
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
// prettier-ignore
const NvidiaProviderSchema = T.Object({ type: T.Literal("nvidia"), ...ProviderCommonProps, baseUrl: Opt(uri), imageBaseUrl: Opt(uri), apiKey: str, models: Opt(T.Array(str)), ratio: Opt(T.Number({ exclusiveMinimum: 0 })), acceptRateLimited: Opt(T.Boolean()) });
// prettier-ignore
const OpenRouterProviderSchema = T.Object({ type: T.Literal("openrouter"), ...ProviderCommonProps, baseUrl: Opt(uri), apiKey: str, models: Opt(T.Array(str)), ratio: Opt(T.Number({ minimum: 0 })), acceptRateLimited: Opt(T.Boolean()) });
// Simple OpenAI-compatible free providers (groq, gemini, cerebras, ...). One schema,
// `type` is the union of registry kinds so a new provider needs no schema edit here.
// T.Unsafe carries the SimpleProviderKind literal union at the type level while the
// runtime T.Union(...) validates the actual kind strings (map() would widen each
// literal to the whole union, so the static type comes from T.Unsafe, not the map).
const SimpleProviderKindSchema = T.Unsafe<SimpleProviderKind>(
  T.Union(SIMPLE_PROVIDER_META.map((m) => T.Literal(m.kind))),
);
const SimpleFreeProviderSchema = T.Object({
  type: SimpleProviderKindSchema,
  ...ProviderCommonProps,
  baseUrl: Opt(uri),
  apiKey: str,
  models: Opt(T.Array(str)),
  ratio: Opt(T.Number({ minimum: 0 })),
  // Models (glob patterns) priced instead of forced-free: each is billed at
  // canonical retail * (1 + priceAdjustment[model]). Everything else stays $0.
  paidModels: Opt(T.Array(str)),
  // Keep models that probe-fail with a 429 (capacity throttle / daily quota
  // spent, not breakage). Only safe where 429 = capacity. Emitted disabled so
  // new-api's auto-test re-enables them once the limit clears.
  acceptRateLimited: Opt(T.Boolean()),
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
  // prettier-ignore
  provider: T.Union([T.Literal("fal"), T.Literal("replicate"), T.Literal("runcomfy"), T.Literal("runpod"), T.Literal("native")]),
  baseUrl: uri,
  apiKey: str,
  app: Opt(str),
  channelName: Opt(str),
  channelTag: Opt(str),
  templates: T.Record(str, ComfyUiTemplateSchema),
});

// A private channel: a routing group NOT added to the global usable list, granted
// only to the provider's identity group via group_special_usable_group, so only
// users whose account group equals that identity may pass X-Group: <group>.
const PrivateChannelSchema = T.Object({
  group: str,
  desc: Opt(str),
  ratio: Opt(T.Number({ minimum: 0 })),
  channelName: Opt(str),
  type: T.Integer({ minimum: 1 }),
  baseUrl: uri,
  apiKey: str,
  models: T.Array(str, { minItems: 1 }),
  modelMapping: Opt(T.Record(T.String(), T.String())),
  paramOverride: Opt(str),
});
export type PrivateChannelConfig = Static<typeof PrivateChannelSchema>;

// A private provider: declarative-only (no discovery/testing/pricing). `channels`
// are private routing groups: registered in GroupRatio but kept off the global
// usable list. Granting access is per-user in the new-api admin UI
// (users.setting.usable_groups). Synced like any provider, so `--only <name>`
// targets it alone.
const PrivateProviderSchema = T.Object({
  type: T.Literal("private"),
  name: str,
  channels: T.Array(PrivateChannelSchema, { minItems: 1 }),
});
export type PrivateProviderConfig = Static<typeof PrivateProviderSchema>;

// prettier-ignore
const AnyProviderSchema = T.Union([NewApiProviderSchema, Sub2ApiProviderSchema, NvidiaProviderSchema, OpenRouterProviderSchema, SimpleFreeProviderSchema, ComfyUiProviderSchema, PrivateProviderSchema]);

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
export type SimpleFreeProviderConfig = Static<
  typeof SimpleFreeProviderSchema
> & {
  type: SimpleProviderKind;
  baseUrl: string;
  ratio: number;
};
export type ComfyUiProviderConfig = Static<typeof ComfyUiProviderSchema>;
// prettier-ignore
export type AnyProviderConfig = ProviderConfig | Sub2ApiProviderConfig | NvidiaProviderConfig | OpenRouterProviderConfig | SimpleFreeProviderConfig | ComfyUiProviderConfig | PrivateProviderConfig;
export type EnabledModelEntry = Static<typeof EnabledModelEntrySchema>;

const LocaleEnum = T.Union([T.Literal("en"), T.Literal("zh")]);
// prettier-ignore
const ThemeEnum = T.Union([T.Literal("light"), T.Literal("dark"), T.Literal("system")]);
// prettier-ignore
const MainTabEnum = T.Union([T.Literal("dashboard"), T.Literal("config"), T.Literal("history")]);
const HistoryTabEnum = T.Union([T.Literal("runs"), T.Literal("authenticity")]);
// prettier-ignore
const RunResultFilterEnum = T.Union([T.Literal("all"), T.Literal("passed"), T.Literal("failed")]);
const PipelineModeEnum = T.Union([T.Literal("run"), T.Literal("reset")]);

export type LocaleValue = Static<typeof LocaleEnum>;
export type ThemeValue = Static<typeof ThemeEnum>;
export type MainTabValue = Static<typeof MainTabEnum>;
export type HistoryTabValue = Static<typeof HistoryTabEnum>;
export type RunResultFilterValue = Static<typeof RunResultFilterEnum>;
export type PipelineModeValue = Static<typeof PipelineModeEnum>;

// prettier-ignore
export const GlobalConfigSchema = T.Object({ locale: Opt(LocaleEnum), theme: Opt(ThemeEnum), mainTab: Opt(MainTabEnum), historyTab: Opt(HistoryTabEnum), selectedRunId: Opt(T.Union([T.String(), T.Null()])), runResultFilter: Opt(RunResultFilterEnum), runQuery: Opt(T.String()), authenticityQuery: Opt(T.String()), selectedConfigName: Opt(T.String()), pipelineMode: Opt(PipelineModeEnum), verbose: Opt(T.Boolean()), onlyProviders: Opt(T.Record(T.String(), T.Array(T.String()))), modelFilter: Opt(T.Record(T.String(), T.String())), blacklist: Opt(T.Array(str)), modelMapping: Opt(T.Record(T.String(), T.String())) });
export type GlobalConfigType = Static<typeof GlobalConfigSchema>;

export const ConfigSchema = T.Object({
  // prettier-ignore
  target: T.Object({ baseUrl: uri, systemAccessToken: str, userId: T.Integer({ minimum: 1 }), targetPrefix: Opt(str) }),
  testModelTypes: Opt(T.Array(ModelTypeEnum)),
  skipUnprofitableText: Opt(T.Boolean()),
  globalConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })),
  perUpstreamConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })),
  blacklist: Opt(T.Array(str)),
  modelMapping: Opt(T.Record(T.String(), T.String())),
  // Publish a paid model under EXTRA names on the SAME channels (one channel, N
  // published names, all routing to the same upstream + sharing pricing). For
  // pure rebrands/aliases (e.g. deepseek-v3.2-exp == deepseek-v3.2) where the alias
  // has no independent upstream source. Keyed by the base PUBLISHED name.
  modelAlias: Opt(T.Record(T.String(), T.Array(str))),
  // prettier-ignore
  rateLimit: Opt(T.Object({
    // success = successful requests per window; total = attempts incl. failures
    // (0/absent = unlimited attempts, failures never burn the budget). windowMinutes
    // overrides the global window per model (scarce media: e.g. 60 = 1/hour).
    models: T.Record(T.String(), T.Object({
      success: T.Integer({ minimum: 1 }),
      total: Opt(T.Integer({ minimum: 0 })),
      windowMinutes: Opt(T.Integer({ minimum: 1, maximum: 10080 })),
    })),
  })),
  providers: T.Array(AnyProviderSchema, { minItems: 1 }),
});

export type ConfigSchemaType = Static<typeof ConfigSchema>;
