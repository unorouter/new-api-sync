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
  // Only the simple free-provider schema carries this; the union's other
  // members legitimately lack it.
  const allowed =
    "allowBlacklisted" in providerConfig
      ? providerConfig.allowBlacklisted
      : undefined;
  return models.filter((id) => {
    // Checked before the blacklist so a globally-fenced name can be readmitted
    // for this provider alone; the fence stays in force everywhere else.
    const exempt = allowed?.length ? matchesAnyPattern(id, allowed) : false;
    if (!exempt && matchesBlacklist(id, config.blacklist, providerConfig.name))
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
