import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import type {
  NvidiaProviderConfig,
  Sub2ApiProviderConfig,
} from "@core/validations/config";
import { inferModelType } from "@core/models/constants/inference";
import {
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/models/constants/patterns";

export function filterModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: NvidiaProviderConfig | Sub2ApiProviderConfig,
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
    if (config.modelFilter?.length) {
      if (!matchesAnyPattern(id, config.modelFilter)) return false;
    }
    return true;
  });
}
