import {
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/catalog/constants/patterns";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import type {
  NvidiaProviderConfig,
  SimpleFreeProviderConfig,
  Sub2ApiProviderConfig,
} from "@core/validations/config";

export function filterModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig:
    | NvidiaProviderConfig
    | Sub2ApiProviderConfig
    | SimpleFreeProviderConfig,
): string[] {
  const modelGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
  return models.filter((id) => {
    if (matchesBlacklist(id, config.blacklist, providerConfig.name))
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
