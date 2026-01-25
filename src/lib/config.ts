import type { Config } from "@/types";
import { isNekoProvider } from "@/types";

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Config file not found: ${path}`);
  const config = (await file.json()) as Config;
  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  if (!config.target?.url) throw new Error("Config missing: target.url");
  if (!config.target?.systemAccessToken)
    throw new Error("Config missing: target.systemAccessToken");
  if (!config.target?.userId) throw new Error("Config missing: target.userId");
  if (!config.providers?.length) throw new Error("Config missing: providers");

  for (const p of config.providers) {
    if (!p.name) throw new Error("Provider missing: name");
    if (!p.baseUrl) throw new Error(`Provider ${p.name} missing: baseUrl`);

    if (isNekoProvider(p)) {
      if (!p.sessionToken)
        throw new Error(`Provider ${p.name} missing: sessionToken`);
    } else {
      if (!p.systemAccessToken)
        throw new Error(`Provider ${p.name} missing: systemAccessToken`);
      if (!p.userId) throw new Error(`Provider ${p.name} missing: userId`);
    }
  }
}
