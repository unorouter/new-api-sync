import {
  FormatRegistry,
  Type as T,
  type Static,
  type TSchema,
} from "@sinclair/typebox";
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
const ProviderCommonProps = { name: str, testModelTypes: Opt(T.Array(ModelTypeEnum)), enabledModels: Opt(T.Array(EnabledModelEntrySchema)), priceAdjustment: Opt(PriceAdjustmentSchema), publishAs: Opt(T.Record(T.String(), str)), perUpstreamConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })), perUpstreamRpm: Opt(T.Number({ exclusiveMinimum: 0, maximum: 6000 })), authenticityPassTtlHours: Opt(T.Number({ exclusiveMinimum: 0, maximum: 720 })), channelLimits: Opt(T.Object({ maxConcurrency: Opt(T.Integer({ minimum: 1, maximum: 10000 })), maxRps: Opt(T.Number({ exclusiveMinimum: 0, maximum: 10000 })) })), autoTestIntervalMinutes: Opt(T.Integer({ minimum: 1, maximum: 10080 })), autoTestIntervalMaxMinutes: Opt(T.Integer({ minimum: 1, maximum: 10080 })), headerOverride: Opt(T.Record(str, str)), forceUpstreamStream: Opt(T.Union([T.Boolean(), T.Record(T.String(), T.Boolean())])) } as const;

// prettier-ignore
const NewApiProviderSchema = T.Object({ type: T.Literal("newapi"), ...ProviderCommonProps, baseUrl: uri, systemAccessToken: str, userId: T.Integer({ minimum: 1 }), acceptRateLimited: Opt(T.Boolean()), acceptUpstreamDown: Opt(T.Boolean()) });
// A scalar for every model, or glob-keyed per model (first match wins) with
// "default" as the catch-all; read through resolvePerModel.
const PerModel = <S extends TSchema>(schema: S) =>
  T.Union([schema, T.Record(T.String(), schema)]);
const ProfitMultipleSchema = PerModel(T.Number({ minimum: 1 }));
const MaxSellFractionSchema = PerModel(
  T.Number({ exclusiveMinimum: 0, maximum: 1 }),
);
const MinSellFractionSchema = PerModel(T.Number({ minimum: 0, maximum: 1 }));
const MinSellersSchema = PerModel(T.Integer({ minimum: 1 }));
// prettier-ignore
// A marketplace, not a relay: /api/pricing publishes one placeholder ratio for
// every model, so price comes from the per-merchant listings, and one upstream
// token is minted and pinned per (model, merchant) lane.
const A7ProviderSchema = T.Object({ type: T.Literal("a7"), ...ProviderCommonProps, baseUrl: uri, systemAccessToken: str, userId: T.Integer({ minimum: 1 }), profitMultiple: Opt(ProfitMultipleSchema), maxSellFraction: Opt(MaxSellFractionSchema), minSellFraction: Opt(MinSellFractionSchema), hostsPerModel: Opt(T.Record(T.String(), T.Integer({ minimum: 1 }))), minSuccessRate: Opt(PerModel(T.Integer({ minimum: 0, maximum: 10000 }))), guaranteedOnly: Opt(T.Boolean()), acceptRateLimited: Opt(T.Boolean()) });
// prettier-ignore
// A flat allowlist, or glob-keyed per model ("claude-*": [bedrock]) with "default" as the catch-all.
const PoolAllowlistSchema = T.Union([T.Array(str, { minItems: 1 }), T.Record(T.String(), T.Array(str))]);
// prettier-ignore
// Fallback lanes behind a7 from a relay with separate supply pools behind one
// key, one lane per allowed pool per enabled model (`<pool>/<model>`). A bare
// request routes to the relay's best-scoring provider at up to half the
// official price, so every lane sends bid headers and is priced at that bid.
// URLs live in config only.
const IhProviderSchema = T.Object({ type: T.Literal("ih"), ...ProviderCommonProps, apiKey: str, baseUrl: uri, catalogUrl: uri, upstreams: PoolAllowlistSchema, profitMultiple: Opt(ProfitMultipleSchema), maxSellFraction: Opt(MaxSellFractionSchema), minSellFraction: Opt(MinSellFractionSchema), bidQuantile: Opt(PerModel(T.Number({ exclusiveMinimum: 0, maximum: 1 }))), minSellers: Opt(MinSellersSchema), acceptRateLimited: Opt(T.Boolean()) });
// prettier-ignore
// Lanes over an order book of resold API keys, one per enabled model, pinned
// to every allowed seller provider (a `provider` body field). The only spend
// guard the market honours is a discount floor in the path (/min{N}), set where
// at least minSellers trusted offers qualify; the lane is priced at that bound.
// URLs live in config only.
const SiProviderSchema = T.Object({ type: T.Literal("si"), ...ProviderCommonProps, apiKey: str, baseUrl: uri, providers: PoolAllowlistSchema, profitMultiple: Opt(ProfitMultipleSchema), maxSellFraction: Opt(MaxSellFractionSchema), minSellFraction: Opt(MinSellFractionSchema), minSellers: Opt(MinSellersSchema), acceptRateLimited: Opt(T.Boolean()) });
// prettier-ignore
const NvidiaProviderSchema = T.Object({ type: T.Literal("nvidia"), ...ProviderCommonProps, baseUrl: Opt(uri), imageBaseUrl: Opt(uri), apiKey: str, models: Opt(T.Array(str)), ratio: Opt(T.Number({ exclusiveMinimum: 0 })), acceptRateLimited: Opt(T.Boolean()) });
// prettier-ignore
const OpenRouterProviderSchema = T.Object({ type: T.Literal("openrouter"), ...ProviderCommonProps, baseUrl: Opt(uri), apiKey: Opt(str), models: Opt(T.Array(str)), ratio: Opt(T.Number({ minimum: 0 })), acceptRateLimited: Opt(T.Boolean()), hostsPerModel: Opt(T.Record(T.String(), T.Integer({ minimum: 1 }))), allowQuantizations: Opt(T.Record(T.String(), T.Array(T.String()))), managementKey: Opt(str), keyDailyLimitUsd: Opt(T.Union([T.Number({ minimum: 0 }), T.Record(T.String(), T.Number({ minimum: 0 }))])), keyExpiryDays: Opt(T.Integer({ minimum: 1 })), requireKeyStore: Opt(T.Boolean()) });
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
  // Keep a bucket whose probe got a 5xx or no reply at all, rather than dropping
  // every model behind it for the run. The models are NOT tested (the host is not
  // answering) and the channels are emitted disabled, so new-api's scheduled test
  // is what brings them back. Use it for providers that are known-good but
  // flaky; on a genuinely retired endpoint it leaves dead channels parked as
  // disabled instead of removing them.
  acceptUpstreamDown: Opt(T.Boolean()),
  // Skip the authenticity probe for this provider only. Set it when the
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

// TypeSafe decisions model (Jev): published id -> upstream id and the SELL price per
// million tokens. The lane serves only POST /v1/decisions; the gateway settles on the
// upstream's own input/output token counts. Defaults point at OpenRouter's alpha route.
// prettier-ignore
const TypeSafeModelSchema = T.Object({ upstream: Opt(str), inputPricePerM: T.Number({ minimum: 0 }), outputPricePerM: T.Number({ minimum: 0 }), contextWindow: Opt(T.Integer({ minimum: 1 })), releaseDate: Opt(str) });
const TypeSafeProviderSchema = T.Object({
  type: T.Literal("typesafe"),
  ...ProviderCommonProps,
  baseUrl: Opt(uri),
  decisionsPath: Opt(str),
  apiKey: str,
  channelName: Opt(str),
  channelTag: Opt(str),
  models: T.Record(str, TypeSafeModelSchema),
});

// prettier-ignore
const AnyProviderSchema = T.Union([NewApiProviderSchema, A7ProviderSchema, IhProviderSchema, SiProviderSchema, NvidiaProviderSchema, OpenRouterProviderSchema, SimpleFreeProviderSchema, ComfyUiProviderSchema, AIHordeProviderSchema, RunwareProviderSchema, TypeSafeProviderSchema]);

export type ProviderConfig = Static<typeof NewApiProviderSchema>;
export type A7ProviderConfig = Static<typeof A7ProviderSchema>;
export type IhProviderConfig = Static<typeof IhProviderSchema>;
export type SiProviderConfig = Static<typeof SiProviderSchema>;
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
export type TypeSafeProviderConfig = Static<typeof TypeSafeProviderSchema>;
// prettier-ignore
export type AnyProviderConfig = ProviderConfig | A7ProviderConfig | IhProviderConfig | SiProviderConfig | NvidiaProviderConfig | OpenRouterProviderConfig | SimpleFreeProviderConfig | ComfyUiProviderConfig | AIHordeProviderConfig | RunwareProviderConfig | TypeSafeProviderConfig;
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
export const GlobalConfigSchema = T.Object({ locale: Opt(LocaleEnum), theme: Opt(ThemeEnum), mainTab: Opt(MainTabEnum), historyTab: Opt(HistoryTabEnum), selectedRunId: Opt(T.Union([T.String(), T.Null()])), runResultFilter: Opt(RunResultFilterEnum), runQuery: Opt(T.String()), authenticityQuery: Opt(T.String()), selectedConfigName: Opt(T.String()), pipelineMode: Opt(PipelineModeEnum), verbose: Opt(T.Boolean()), onlyProviders: Opt(T.Record(T.String(), T.Array(T.String()))), modelFilter: Opt(T.Record(T.String(), T.String())), blacklist: Opt(T.Array(str)), modelMapping: Opt(T.Record(T.String(), T.String())), groupMapping: Opt(T.Record(T.String(), T.String())), channelParamOverride: Opt(T.Array(T.Object({ channels: T.Array(str, { minItems: 1 }), operations: T.Array(T.Record(T.String(), T.Unknown()), { minItems: 1 }) }))) });
export type GlobalConfigType = Static<typeof GlobalConfigSchema>;

export const ConfigSchema = T.Object({
  // prettier-ignore
  target: T.Object({ baseUrl: uri, systemAccessToken: str, userId: T.Integer({ minimum: 1 }), targetPrefix: Opt(str) }),
  testModelTypes: Opt(T.Array(ModelTypeEnum)),
  // Optional S3-compatible home for logs/verdict-cache.json and the run
  // artifacts, shared between every machine that runs the sync. Absent = local only.
  verdictStore: Opt(
    T.Object({
      endpoint: uri,
      bucket: str,
      accessKeyId: str,
      secretAccessKey: str,
      region: Opt(str),
      prefix: Opt(T.String()),
      encryptionKey: Opt(str),
    }),
  ),
  // Read-only DSN of the gateway's own postgres, for `sync reconcile` (our
  // logs are not reachable through the scoped service token). Absent = the
  // reconcile runs provider-side checks only.
  targetDb: Opt(T.Object({ url: str })),
  // Public IPs our gateway egresses from. When set, `sync reconcile` flags
  // upstream rows logged from any other address.
  targetEgressIps: Opt(T.Array(str)),
  skipUnprofitableText: Opt(T.Boolean()),
  globalConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })),
  perUpstreamConcurrency: Opt(T.Integer({ minimum: 1, maximum: 1000 })),
  blacklist: Opt(T.Array(str)),
  // Authenticity ladder rules that only log, per maker id (`deepseek`, `openai`,
  // ...) or `*` for every maker without its own entry. Absent: every rule
  // observes for every maker except anthropic. `[]` gives a maker's verdicts
  // authority.
  authenticity: Opt(
    T.Object({
      observeOnly: Opt(T.Record(T.String(), T.Array(str))),
      // The one-word answer battery: `repeats` per cell per ladder run
      // (default 3, 24 calls), Jensen-Shannon thresholds in bits (0.25 match,
      // 0.35 mismatch) and the valid answers a cell needs before it counts (10).
      answerFingerprint: Opt(
        T.Object({
          repeats: Opt(T.Integer({ minimum: 1, maximum: 10 })),
          matchBits: Opt(T.Number({ minimum: 0, maximum: 1 })),
          mismatchBits: Opt(T.Number({ minimum: 0, maximum: 1 })),
          minCellSamples: Opt(T.Integer({ minimum: 1 })),
        }),
      ),
    }),
  ),
  modelMapping: Opt(T.Record(T.String(), T.String())),
  // Splice upstream group labels before they become channel names: key is a
  // fragment (optionally `provider/fragment`), value replaces just that fragment.
  // Runs after the blacklist, so it renames a lane rather than readmitting one.
  groupMapping: Opt(T.Record(T.String(), T.String())),
  // Publish a paid model under EXTRA names on the SAME channels (one channel, N
  // published names, all routing to the same upstream + sharing pricing). For
  // pure rebrands/aliases (e.g. deepseek-v3.2-exp == deepseek-v3.2) where the alias
  // has no independent upstream source. Keyed by the base PUBLISHED name.
  modelAlias: Opt(T.Record(T.String(), T.Array(str))),
  // Inject a channel-level system prompt on every channel whose PUBLISHED model
  // matches the glob. `override` (default false) prepends ours to a user-supplied
  // system message; false only injects when the request carries none. Keyed by
  // model glob (micromatch). Used to lift soft refusals on CN models (deepseek/glm).
  // `providers` narrows a rule to those provider names, for a lane-specific prompt.
  // Empty prompt = clear a previously synced prompt from matching channels.
  // prettier-ignore
  systemPrompt: Opt(T.Array(T.Object({ models: T.Array(str, { minItems: 1 }), prompt: T.String(), override: Opt(T.Boolean()), providers: Opt(T.Array(str)) }))),
  // Extra channel param_override operations for channels whose NAME matches a
  // glob (micromatch): merged onto whatever override the channel already carries.
  // For upstreams that 400 on a sampler field only some lanes reject.
  // prettier-ignore
  channelParamOverride: Opt(T.Array(T.Object({ channels: T.Array(str, { minItems: 1 }), operations: T.Array(T.Record(T.String(), T.Unknown()), { minItems: 1 }) }))),
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
