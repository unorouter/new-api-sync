import {
  findBlacklistMatch,
  matchesAnyPattern,
} from "@core/catalog/constants/patterns";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import type { AnyProviderConfig } from "@core/validations/config";

export type ConfigState =
  | { kind: "enabled" }
  | { kind: "blacklisted"; rule: string }
  | { kind: "not_in_enabledModels" };

/** Why config keeps or drops one upstream id for one provider; --models is not part of it. */
export function configStateOf(
  id: string,
  config: RuntimeConfig,
  providerConfig: AnyProviderConfig,
): ConfigState {
  // Checked before the blacklist so a globally-fenced name can be readmitted
  // for this provider alone; the fence stays in force everywhere else.
  const allowed =
    "allowBlacklisted" in providerConfig
      ? providerConfig.allowBlacklisted
      : undefined;
  const exempt = allowed?.length ? matchesAnyPattern(id, allowed) : false;
  const rule = exempt
    ? undefined
    : findBlacklistMatch(id, config.blacklist, providerConfig.name);
  if (rule !== undefined) return { kind: "blacklisted", rule };
  const modelGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
  if (modelGlobs?.length && !matchesAnyPattern(id, modelGlobs))
    return { kind: "not_in_enabledModels" };
  return { kind: "enabled" };
}

export function filterModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: AnyProviderConfig,
): string[] {
  return models.filter((id) => {
    if (configStateOf(id, config, providerConfig).kind !== "enabled")
      return false;
    if (config.modelFilter?.length) {
      if (!matchesAnyPattern(id, config.modelFilter)) return false;
    }
    return true;
  });
}
