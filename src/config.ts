import { z, ZodError } from "zod/v4";

// ============ Schema ============

const str = z.string().trim().min(1);

const PriceAdjustmentSchema = z.union([
  z.number().gt(-1).lt(1),
  z.record(z.string(), z.number().gt(-1).lt(1)).refine((v) => "default" in v, {
    message: "priceAdjustment object must contain a default key",
  }),
]);

const ProviderCommon = z.object({
  name: str,
  enabledGroups: z.array(str).optional(),
  enabledVendors: z.array(str).optional(),
  enabledModels: z.array(str).optional(),
  priceAdjustment: PriceAdjustmentSchema.optional(),
});

const NewApiProviderSchema = ProviderCommon.extend({
  type: z.literal("newapi"),
  baseUrl: z.url(),
  systemAccessToken: str,
  userId: z.number().int().positive(),
});

const Sub2ApiProviderSchema = ProviderCommon.extend({
  type: z.literal("sub2api"),
  baseUrl: z.url(),
  adminApiKey: str.optional(),
  groups: z
    .array(z.object({ key: str, platform: str, name: str.optional() }))
    .min(1)
    .optional(),
}).superRefine((p, ctx) => {
  if (!p.adminApiKey && (!p.groups || p.groups.length === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["adminApiKey"],
      message: "sub2api provider requires adminApiKey or groups",
    });
  }
});

export type ProviderConfig = z.output<typeof NewApiProviderSchema>;
export type Sub2ApiProviderConfig = z.output<typeof Sub2ApiProviderSchema>;
export type AnyProviderConfig = ProviderConfig | Sub2ApiProviderConfig;

const ConfigSchema = z
  .object({
    target: z.object({
      baseUrl: z.url(),
      systemAccessToken: str,
      userId: z.number().int().positive(),
      targetPrefix: str.optional(),
    }),
    blacklist: z.array(str).default([]),
    modelMapping: z.record(z.string(), z.string()).default({}),
    providers: z
      .array(
        z.discriminatedUnion("type", [
          NewApiProviderSchema,
          Sub2ApiProviderSchema,
        ]),
      )
      .min(1),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [i, p] of config.providers.entries()) {
      if (seen.has(p.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", i, "name"],
          message: `duplicate provider name: ${p.name}`,
        });
      }
      seen.add(p.name);
    }
  });

export interface RuntimeConfig extends z.output<typeof ConfigSchema> {
  onlyProviders?: Set<string>;
}

// ============ Loader ============

export async function loadConfig(path?: string): Promise<RuntimeConfig> {
  let resolvedPath = path;
  if (!resolvedPath) {
    if (await Bun.file("./config.jsonc").exists())
      resolvedPath = "./config.jsonc";
    else if (await Bun.file("./config.json").exists())
      resolvedPath = "./config.json";
    else
      throw new Error("No config file found (tried config.jsonc, config.json)");
  }

  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = Bun.JSONC.parse(await file.text());
  } catch (error) {
    throw new Error(
      `Invalid JSONC in ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = ConfigSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    throw new Error(
      `Config validation failed:\n${(parsed.error as ZodError).issues
        .map(
          (i) =>
            `${i.path.length > 0 ? i.path.join(".") : "root"}: ${i.message}`,
        )
        .join("\n")}`,
    );
  }

  return parsed.data;
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
