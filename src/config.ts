import { z, ZodError } from "zod/v4";

// ============ Schema ============

const UrlSchema = z.url();
const NonEmptyString = z.string().trim().min(1);

const PriceAdjustmentNumberSchema = z
  .number()
  .gt(-1, "priceAdjustment must be > -1")
  .lt(1, "priceAdjustment must be < 1");

const PriceAdjustmentRecordSchema = z
  .record(z.string(), PriceAdjustmentNumberSchema)
  .refine((value) => "default" in value, {
    message: "priceAdjustment object must contain a default key"
  });

export const PriceAdjustmentSchema = z.union([
  PriceAdjustmentNumberSchema,
  PriceAdjustmentRecordSchema
]);

const TargetSchema = z.object({
  baseUrl: UrlSchema,
  systemAccessToken: NonEmptyString,
  userId: z.number().int().positive()
});

const ProviderCommonSchema = z.object({
  name: NonEmptyString,
  enabledGroups: z.array(NonEmptyString).optional(),
  enabledVendors: z.array(NonEmptyString).optional(),
  enabledModels: z.array(NonEmptyString).optional(),
  priceAdjustment: PriceAdjustmentSchema.optional()
});

const NewApiProviderSchema = ProviderCommonSchema.extend({
  type: z.literal("newapi"),
  baseUrl: UrlSchema,
  systemAccessToken: NonEmptyString,
  userId: z.number().int().positive()
});

const Sub2ApiGroupSchema = z.object({
  key: NonEmptyString,
  platform: NonEmptyString,
  name: NonEmptyString.optional()
});

const Sub2ApiProviderSchema = ProviderCommonSchema.extend({
  type: z.literal("sub2api"),
  baseUrl: UrlSchema,
  adminApiKey: NonEmptyString.optional(),
  groups: z.array(Sub2ApiGroupSchema).min(1).optional()
}).superRefine((provider, ctx) => {
  if (
    !provider.adminApiKey &&
    (!provider.groups || provider.groups.length === 0)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["adminApiKey"],
      message: "sub2api provider requires adminApiKey or groups"
    });
  }
});

export const ProviderSchema = z.discriminatedUnion("type", [
  NewApiProviderSchema,
  Sub2ApiProviderSchema
]);

export const ConfigSchema = z
  .object({
    target: TargetSchema,
    blacklist: z.array(NonEmptyString).default([]),
    modelMapping: z.record(z.string(), z.string()).default({}),
    providers: z.array(ProviderSchema).min(1)
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, provider] of config.providers.entries()) {
      if (seen.has(provider.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "name"],
          message: `duplicate provider name: ${provider.name}`
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

// ============ Loader ============

async function resolveConfigPath(explicitPath?: string): Promise<string> {
  if (explicitPath) return explicitPath;
  if (await Bun.file("./config.jsonc").exists()) return "./config.jsonc";
  if (await Bun.file("./config.json").exists()) return "./config.json";
  throw new Error("No config file found (tried config.jsonc, config.json)");
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

export async function loadConfig(path?: string): Promise<RuntimeConfig> {
  const resolvedPath = await resolveConfigPath(path);
  const file = Bun.file(resolvedPath);

  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const rawText = await file.text();
  let parsedRaw: unknown;
  try {
    parsedRaw = Bun.JSONC.parse(rawText);
  } catch (error) {
    throw new Error(
      `Invalid JSONC in ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = ConfigSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    throw new Error(
      `Config validation failed:\n${formatZodError(parsed.error)}`
    );
  }

  return parsed.data;
}

export function applyOnlyProviders(
  config: RuntimeConfig,
  onlyNames: string[]
): RuntimeConfig {
  if (onlyNames.length === 0) return config;

  const normalized = onlyNames
    .flatMap((name) => name.split(","))
    .map((name) => name.trim())
    .filter(Boolean);

  if (normalized.length === 0) return config;

  const available = new Set(config.providers.map((provider) => provider.name));
  const unknown = normalized.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown provider(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`
    );
  }

  const onlySet = new Set(normalized);
  return {
    ...config,
    providers: config.providers.filter((provider) =>
      onlySet.has(provider.name)
    ),
    onlyProviders: onlySet
  };
}
