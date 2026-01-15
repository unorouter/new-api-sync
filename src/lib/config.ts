import type { Config } from "@/types";

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }

  return file.json();
}

export function validateConfig(config: Config): void {
  if (!config.target?.url) {
    throw new Error("Config missing: target.url");
  }
  if (!config.target?.adminToken) {
    throw new Error("Config missing: target.adminToken");
  }
  if (!config.providers || config.providers.length === 0) {
    throw new Error("Config missing: providers (at least one required)");
  }

  for (const provider of config.providers) {
    if (!provider.name) {
      throw new Error("Provider missing: name");
    }
    if (!provider.baseUrl) {
      throw new Error(`Provider ${provider.name} missing: baseUrl`);
    }
    if (!provider.accessToken) {
      throw new Error(`Provider ${provider.name} missing: accessToken`);
    }
  }
}
