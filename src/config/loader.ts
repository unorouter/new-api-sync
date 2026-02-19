import { ConfigSchema, type RuntimeConfig } from "@/config/schema";
import { ZodError } from "zod/v4";

export async function resolveConfigPath(explicitPath?: string): Promise<string> {
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
    throw new Error(`Invalid JSONC in ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = ConfigSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    throw new Error(`Config validation failed:\n${formatZodError(parsed.error)}`);
  }

  return parsed.data;
}

export function applyOnlyProviders(config: RuntimeConfig, onlyNames: string[]): RuntimeConfig {
  if (onlyNames.length === 0) return config;

  const normalized = onlyNames
    .flatMap((name) => name.split(","))
    .map((name) => name.trim())
    .filter(Boolean);

  if (normalized.length === 0) return config;

  const available = new Set(config.providers.map((provider) => provider.name));
  const unknown = normalized.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown provider(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`);
  }

  const onlySet = new Set(normalized);
  return {
    ...config,
    providers: config.providers.filter((provider) => onlySet.has(provider.name)),
    onlyProviders: onlySet,
  };
}
