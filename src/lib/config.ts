import type { Config } from "@/types";

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Config file not found: ${path}`);
  return migrateConfig(await file.json());
}

function migrateConfig(raw: any): Config {
  const target = raw.target ?? {};
  return {
    target: {
      url: target.url,
      systemAccessToken: target.systemAccessToken ?? target.adminToken,
      userId: target.userId,
    },
    providers: (raw.providers ?? []).map((p: any) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      systemAccessToken: p.systemAccessToken ?? p.accessToken ?? p.auth?.accessToken,
      userId: p.userId ?? p.auth?.userId,
      enabledGroups: p.enabledGroups,
      priority: p.priority,
    })),
    options: raw.options,
  };
}

export function validateConfig(config: Config): void {
  if (!config.target?.url) throw new Error("Config missing: target.url");
  if (!config.target?.systemAccessToken) throw new Error("Config missing: target.systemAccessToken");
  if (!config.target?.userId) throw new Error("Config missing: target.userId");
  if (!config.providers?.length) throw new Error("Config missing: providers");

  for (const p of config.providers) {
    if (!p.name) throw new Error("Provider missing: name");
    if (!p.baseUrl) throw new Error(`Provider ${p.name} missing: baseUrl`);
    if (!p.systemAccessToken) throw new Error(`Provider ${p.name} missing: systemAccessToken`);
    if (!p.userId) throw new Error(`Provider ${p.name} missing: userId`);
  }
}
