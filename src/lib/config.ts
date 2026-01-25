import type {
  AnyProviderConfig,
  Config,
  NekoProviderConfig,
  ProviderConfig,
} from "@/types";
import { isNekoProvider } from "@/types";

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Config file not found: ${path}`);
  return migrateConfig(await file.json());
}

function migrateProvider(p: any): AnyProviderConfig {
  if (p.type === "neko") {
    return {
      type: "neko",
      name: p.name,
      baseUrl: p.baseUrl,
      sessionToken: p.sessionToken,
      enabledGroups: p.enabledGroups,
      enabledVendors: p.enabledVendors,
      priority: p.priority,
      priceMultiplier: p.priceMultiplier,
    } as NekoProviderConfig;
  }

  return {
    type: p.type ?? "newapi",
    name: p.name,
    baseUrl: p.baseUrl,
    systemAccessToken:
      p.systemAccessToken ?? p.accessToken ?? p.auth?.accessToken,
    userId: p.userId ?? p.auth?.userId,
    enabledGroups: p.enabledGroups,
    enabledVendors: p.enabledVendors,
    priority: p.priority,
    priceMultiplier: p.priceMultiplier,
  } as ProviderConfig;
}

function migrateConfig(raw: any): Config {
  const target = raw.target ?? {};
  return {
    target: {
      url: target.url,
      systemAccessToken: target.systemAccessToken ?? target.adminToken,
      userId: target.userId,
    },
    providers: (raw.providers ?? []).map(migrateProvider),
    options: raw.options,
  };
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
