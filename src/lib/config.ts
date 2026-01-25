import type { Config } from "@/lib/types";

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Config file not found: ${path}`);
  const config = (await file.json()) as Config;
  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  if (!config.target?.baseUrl) throw new Error("Config missing: target.baseUrl");
  if (!config.target?.systemAccessToken)
    throw new Error("Config missing: target.systemAccessToken");
  if (!config.target?.userId) throw new Error("Config missing: target.userId");
  if (!config.providers?.length) throw new Error("Config missing: providers");

  for (const p of config.providers) {
    if (!p.name) throw new Error("Provider missing: name");
    if (!p.baseUrl) throw new Error(`Provider ${p.name} missing: baseUrl`);

    if (p.type === "neko") {
      if (!("sessionToken" in p) || !p.sessionToken)
        throw new Error(`Provider ${p.name} missing: sessionToken`);
    } else {
      if (!("systemAccessToken" in p) || !p.systemAccessToken)
        throw new Error(`Provider ${p.name} missing: systemAccessToken`);
      if (!("userId" in p) || !p.userId)
        throw new Error(`Provider ${p.name} missing: userId`);
    }
  }
}
