import { applyOnlyProviders, loadConfig } from "@/config/loader";
import type { RuntimeConfig } from "@/config/schema";

export function collectOnly(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function loadRuntimeConfig(
  configPath: string | undefined,
  only: string[],
): Promise<RuntimeConfig> {
  const config = await loadConfig(configPath);
  return applyOnlyProviders(config, only);
}
