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

// adj > 0 is a position between cost and canonical (applyPriceAdjustment): 1 = sell
// exactly at 1x. adj <= 0 is a plain cost multiplier (yuan convention).
const PriceAdjustmentSchema = T.Union([
  T.Number({ exclusiveMinimum: -1, maximum: 1 }),
  T.Record(T.String(), T.Number({ exclusiveMinimum: -1, maximum: 1 })),
]);

const GridPricingRowSchema = T.Record(
  T.String(),
  T.Union([T.String(), T.Number()]),
);

// prettier-ignore
const ModelMetadataSchema = T.Object({ maxOutputTokens: Opt(T.Integer({ minimum: 1 })), isReasoning: Opt(T.Boolean()), disableThinking: Opt(T.Boolean()), supportedParams: Opt(T.Array(str, { minItems: 1 })) });
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
const ProviderCommonProps = { name: str, testModelTypes: Opt(T.Array(ModelTypeEnum)), enabledVendors: Opt(T.Array(str)), enabledModels: Opt(T.Array(EnabledModelEntrySchema)), priceAdjustment: Opt(PriceAdjustmentSchema), perUpstreamConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })), autoTestIntervalMinutes: Opt(T.Integer({ minimum: 1, maximum: 10080 })), autoTestIntervalMaxMinutes: Opt(T.Integer({ minimum: 1, maximum: 10080 })) } as const;

// prettier-ignore
const NewApiProviderSchema = T.Object({ type: T.Literal("newapi"), ...ProviderCommonProps, baseUrl: uri, systemAccessToken: str, userId: T.Integer({ minimum: 1 }), acceptRateLimited: Opt(T.Boolean()) });
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
const OpenRouterProviderSchema = T.Object({ type: T.Literal("openrouter"), ...ProviderCommonProps, baseUrl: Opt(uri), apiKey: str, models: Opt(T.Array(str)), ratio: Opt(T.Number({ minimum: 0 })), acceptRateLimited: Opt(T.Boolean()), hostsPerModel: Opt(T.Record(T.String(), T.Integer({ minimum: 1 }))) });
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
  // Models (glob patterns) priced instead of forced-free: retail sits
  // priceAdjustment of the way from the cheapest lane to canonical (adj=1 -> 1x).
  // Everything else stays $0.
  paidModels: Opt(T.Array(str)),
  // Keep models that probe-fail with a 429 (capacity throttle / daily quota
  // spent, not breakage). Only safe where 429 = capacity. Emitted disabled so
  // new-api's auto-test re-enables them once the limit clears.
  acceptRateLimited: Opt(T.Boolean()),
  // Skip the claude authenticity probe for this provider only. Set it when the
  // upstream is a VERIFIED first-party Claude that fails the probe for a known
  // reason, not to silence a suspicious relay: the probe exists to catch a
  // cheap model wearing an expensive label, and blanket-disabling it is how a
  // fake gets sold as real. Record the verification in the provider comment.
  skipAuthenticity: Opt(T.Boolean()),
  // Model globs exempted from the blacklist for THIS provider only. The
  // blacklist fences a name everywhere because some relay was reselling it
  // dishonestly; this readmits it for the one provider known to serve it
  // legitimately, without reopening the name globally. Narrower than deleting
  // the fence and narrower than scoping it per offender, since a new offender
  // is still blocked by default.
  allowBlacklisted: Opt(T.Array(str)),
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

// AI Horde image model: published id -> per-call price + default gen params. The
// Go adapter (channel type AIHorde) merges these under client size/metadata.
// prettier-ignore
const AIHordeModelSchema = T.Object({ price: T.Number({ minimum: 0 }), hordeModel: Opt(str), width: Opt(T.Integer({ minimum: 64, maximum: 3072 })), height: Opt(T.Integer({ minimum: 64, maximum: 3072 })), steps: Opt(T.Integer({ minimum: 1 })), cfgScale: Opt(T.Number({ minimum: 0 })), samplerName: Opt(str), karras: Opt(T.Boolean()), clipSkip: Opt(T.Integer({ minimum: 1, maximum: 12 })) });
const AIHordeProviderSchema = T.Object({
  type: T.Literal("aihorde"),
  ...ProviderCommonProps,
  baseUrl: Opt(uri),
  apiKey: str,
  channelName: Opt(str),
  channelTag: Opt(str),
  models: T.Record(str, AIHordeModelSchema),
});

// Runware image model: published id -> per-call price + the AIR identifier the
// upstream is addressed by (civitai:257749@290640). The AIR travels as a model
// mapping rather than a params blob, since Runware takes it as the model name.
// prettier-ignore
const RunwareModelSchema = T.Object({ price: T.Number({ minimum: 0 }), air: str, width: Opt(T.Integer({ minimum: 64, maximum: 3072 })), height: Opt(T.Integer({ minimum: 64, maximum: 3072 })) });
const RunwareProviderSchema = T.Object({
  type: T.Literal("runware"),
  ...ProviderCommonProps,
  baseUrl: Opt(uri),
  apiKey: str,
  channelName: Opt(str),
  channelTag: Opt(str),
  models: T.Record(str, RunwareModelSchema),
});

// prettier-ignore
const AnyProviderSchema = T.Union([NewApiProviderSchema, Sub2ApiProviderSchema, NvidiaProviderSchema, OpenRouterProviderSchema, SimpleFreeProviderSchema, ComfyUiProviderSchema, AIHordeProviderSchema, RunwareProviderSchema]);

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
export type AIHordeProviderConfig = Static<typeof AIHordeProviderSchema>;
export type RunwareProviderConfig = Static<typeof RunwareProviderSchema>;
// prettier-ignore
export type AnyProviderConfig = ProviderConfig | Sub2ApiProviderConfig | NvidiaProviderConfig | OpenRouterProviderConfig | SimpleFreeProviderConfig | ComfyUiProviderConfig | AIHordeProviderConfig | RunwareProviderConfig;
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
  // Inject a channel-level system prompt on every channel whose PUBLISHED model
  // matches the glob. `override` (default false) prepends ours to a user-supplied
  // system message; false only injects when the request carries none. Keyed by
  // model glob (micromatch). Used to lift soft refusals on CN models (deepseek/glm).
  // Empty prompt = clear a previously synced prompt from matching channels.
  // prettier-ignore
  systemPrompt: Opt(T.Array(T.Object({ models: T.Array(str, { minItems: 1 }), prompt: T.String(), override: Opt(T.Boolean()) }))),
  // prettier-ignore
  rateLimit: Opt(T.Object({
    // success = successful requests per window; total = attempts incl. failures
    // (0/absent = unlimited attempts, failures never burn the budget). windowMinutes
    // overrides the global window per model (scarce media: e.g. 60 = 1/hour).
    // modality = default cap per model type (resolved by inferModelType); new models
    // inherit it with no config edit. models globs OVERRIDE the modality default.
    modality: Opt(T.Record(ModelTypeEnum, T.Object({
      success: T.Integer({ minimum: 1 }),
      total: Opt(T.Integer({ minimum: 0 })),
      windowMinutes: Opt(T.Integer({ minimum: 1, maximum: 10080 })),
    }))),
    models: Opt(T.Record(T.String(), T.Object({
      success: T.Integer({ minimum: 1 }),
      total: Opt(T.Integer({ minimum: 0 })),
      windowMinutes: Opt(T.Integer({ minimum: 1, maximum: 10080 })),
    }))),
  })),
  providers: T.Array(AnyProviderSchema, { minItems: 1 }),
});

export type ConfigSchemaType = Static<typeof ConfigSchema>;
