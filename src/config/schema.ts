import { z } from "zod/v4";

const UrlSchema = z.url();
const NonEmptyString = z.string().trim().min(1);

const PriceAdjustmentNumberSchema = z
  .number()
  .gt(-1, "priceAdjustment must be > -1")
  .lt(1, "priceAdjustment must be < 1");

const PriceAdjustmentRecordSchema = z
  .record(z.string(), PriceAdjustmentNumberSchema)
  .refine((value) => "default" in value, {
    message: "priceAdjustment object must contain a default key",
  });

export const PriceAdjustmentSchema = z.union([
  PriceAdjustmentNumberSchema,
  PriceAdjustmentRecordSchema,
]);

const TargetSchema = z.object({
  baseUrl: UrlSchema,
  systemAccessToken: NonEmptyString,
  userId: z.number().int().positive(),
});

const ProviderCommonSchema = z.object({
  name: NonEmptyString,
  enabledGroups: z.array(NonEmptyString).optional(),
  enabledVendors: z.array(NonEmptyString).optional(),
  enabledModels: z.array(NonEmptyString).optional(),
  priceAdjustment: PriceAdjustmentSchema.optional(),
});

const NewApiProviderSchema = ProviderCommonSchema.extend({
  type: z.literal("newapi"),
  baseUrl: UrlSchema,
  systemAccessToken: NonEmptyString,
  userId: z.number().int().positive(),
});

const DirectProviderSchema = ProviderCommonSchema.extend({
  type: z.literal("direct"),
  vendor: NonEmptyString,
  baseUrl: UrlSchema.optional(),
  apiKey: NonEmptyString,
  groupRatio: z.number().positive().optional(),
}).superRefine((provider, ctx) => {
  if (provider.groupRatio !== undefined && provider.priceAdjustment !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["groupRatio"],
      message: "groupRatio and priceAdjustment cannot be used together",
    });
  }
});

const Sub2ApiGroupSchema = z.object({
  key: NonEmptyString,
  platform: NonEmptyString,
  name: NonEmptyString.optional(),
});

const Sub2ApiProviderSchema = ProviderCommonSchema.extend({
  type: z.literal("sub2api"),
  baseUrl: UrlSchema,
  adminApiKey: NonEmptyString.optional(),
  groups: z.array(Sub2ApiGroupSchema).min(1).optional(),
}).superRefine((provider, ctx) => {
  if (!provider.adminApiKey && (!provider.groups || provider.groups.length === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["adminApiKey"],
      message: "sub2api provider requires adminApiKey or groups",
    });
  }
});

export const ProviderSchema = z.discriminatedUnion("type", [
  NewApiProviderSchema,
  DirectProviderSchema,
  Sub2ApiProviderSchema,
]);

export const ConfigSchema = z
  .object({
    target: TargetSchema,
    blacklist: z.array(NonEmptyString).default([]),
    modelMapping: z.record(z.string(), z.string()).default({}),
    providers: z.array(ProviderSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, provider] of config.providers.entries()) {
      if (seen.has(provider.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "name"],
          message: `duplicate provider name: ${provider.name}`,
        });
      }
      seen.add(provider.name);
    }
  });

export type AppConfig = z.output<typeof ConfigSchema>;
export type ProviderConfig = AppConfig["providers"][number];

export interface RuntimeConfig extends AppConfig {
  onlyProviders?: Set<string>;
}
