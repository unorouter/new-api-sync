import type { Config, Sub2ApiProviderConfig } from "@/lib/types";

export async function loadConfig(path?: string): Promise<Config> {
  const resolved = path ?? await resolveDefaultConfig();
  const file = Bun.file(resolved);
  if (!(await file.exists())) throw new Error(`Config file not found: ${resolved}`);
  const text = await file.text();
  const config = Bun.JSONC.parse(text) as Config;
  validateConfig(config);
  return config;
}

async function resolveDefaultConfig(): Promise<string> {
  if (await Bun.file("./config.jsonc").exists()) return "./config.jsonc";
  if (await Bun.file("./config.json").exists()) return "./config.json";
  throw new Error("No config file found (tried config.jsonc, config.json)");
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(config: Config): void {
  // Validate target
  if (!config.target?.baseUrl) throw new Error("Config missing: target.baseUrl");
  if (!isValidUrl(config.target.baseUrl))
    throw new Error(`Invalid URL: target.baseUrl = "${config.target.baseUrl}"`);
  if (!config.target?.systemAccessToken)
    throw new Error("Config missing: target.systemAccessToken");
  if (!config.target?.userId) throw new Error("Config missing: target.userId");
  if (typeof config.target.userId !== "number" || config.target.userId <= 0)
    throw new Error(`Invalid userId: target.userId must be positive number`);

  // Validate providers
  config.providers ??= [];

  const providerNames = new Set<string>();
  for (const p of config.providers) {
    if (!p.name) throw new Error("Provider missing: name");
    if (providerNames.has(p.name))
      throw new Error(`Duplicate provider name: "${p.name}"`);
    providerNames.add(p.name);

    if (!p.baseUrl) throw new Error(`Provider "${p.name}" missing: baseUrl`);
    if (!isValidUrl(p.baseUrl))
      throw new Error(`Invalid URL: provider "${p.name}" baseUrl = "${p.baseUrl}"`);

    if (p.type === "sub2api") {
      const sp = p as Sub2ApiProviderConfig;
      if (!sp.adminApiKey)
        throw new Error(`Provider "${p.name}" missing: adminApiKey`);
      if (sp.priceAdjustment !== undefined && sp.priceAdjustment >= 1)
        throw new Error(
          `Invalid priceAdjustment: provider "${p.name}" must be less than 1 (e.g. 0.1 = 10% cheaper, -0.1 = 10% more expensive)`,
        );
      continue;
    }

    if (!("systemAccessToken" in p) || !p.systemAccessToken)
      throw new Error(`Provider "${p.name}" missing: systemAccessToken`);
    if (!("userId" in p) || !p.userId)
      throw new Error(`Provider "${p.name}" missing: userId`);
    if (typeof p.userId !== "number" || p.userId <= 0)
      throw new Error(`Invalid userId: provider "${p.name}" userId must be positive number`);

    if (p.priceMultiplier !== undefined && p.priceMultiplier <= 0)
      throw new Error(
        `Invalid priceMultiplier: provider "${p.name}" must be positive`,
      );
  }

  // Validate modelMapping
  if (config.modelMapping) {
    if (typeof config.modelMapping !== "object")
      throw new Error("Invalid modelMapping: must be object");
    for (const [from, to] of Object.entries(config.modelMapping)) {
      if (typeof from !== "string" || typeof to !== "string")
        throw new Error(`Invalid modelMapping: "${from}" -> "${to}" must be strings`);
    }
  }
}
