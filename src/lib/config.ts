/**
 * Config loader with environment variable interpolation
 */

import type { Config } from "@/types";

/**
 * Load config from a JSON file with ${ENV_VAR} interpolation
 */
export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }

  const content = await file.text();
  const config = JSON.parse(content);

  return interpolateEnvVars(config) as Config;
}

/**
 * Recursively interpolate ${ENV_VAR} patterns in config values
 */
function interpolateEnvVars<T>(obj: T): T {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (match, name) => {
      const value = process.env[name];
      if (value === undefined) {
        throw new Error(`Missing environment variable: ${name}`);
      }
      return value;
    }) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars) as T;
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result as T;
  }

  return obj;
}

/**
 * Validate config structure
 */
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
    if (!provider.auth?.accessToken) {
      throw new Error(`Provider ${provider.name} missing: auth.accessToken`);
    }
    if (!provider.auth?.userId) {
      throw new Error(`Provider ${provider.name} missing: auth.userId`);
    }
  }
}
