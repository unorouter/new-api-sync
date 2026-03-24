import { getEnabledModelGlobs } from "@/config";
import type { DirectProviderConfig, RuntimeConfig, Sub2ApiProviderConfig } from "@/config";
import { inferModelType, matchesAnyPattern, matchesBlacklist } from "@/lib/constants";

export function filterModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: DirectProviderConfig | Sub2ApiProviderConfig,
): string[] {
  const modelGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
  // Blacklist only applies to text models — image/video/audio/embedding are never blacklisted
  return models.filter((id) => {
    if (
      inferModelType(id) === "text" &&
      matchesBlacklist(id, config.blacklist, providerConfig.name)
    )
      return false;
    if (modelGlobs?.length) {
      if (!matchesAnyPattern(id, modelGlobs)) return false;
    }
    return true;
  });
}
