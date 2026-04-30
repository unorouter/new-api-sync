import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import {
  buildChannelModelMapping,
  resolveBareNames,
  toBareName,
} from "@core/models/bare-name";
import {
  CHANNEL_TYPES,
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/models/constants";
import { testAndFilterModels } from "@core/models/tester";
import { pushPerVendorChannels } from "@core/providers/shared/pipeline";
import type { OpenRouterProviderConfig } from "@core/validations/config";
import type { ProviderReport, SyncState } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import { discoverOpenRouterFreeModels } from "./discovery";

export async function processOpenRouterProvider(
  providerConfig: OpenRouterProviderConfig,
  config: RuntimeConfig,
  state: SyncState,
): Promise<ProviderReport> {
  const report: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };

  try {
    let candidateIds: string[];

    if (providerConfig.models?.length) {
      candidateIds = [...providerConfig.models];
      consola.info(
        t("CORE.OPENROUTER.EXPLICIT_SKIP_DISCOVERY", {
          name: providerConfig.name,
          count: candidateIds.length,
        }),
      );
    } else {
      const freeIds = await discoverOpenRouterFreeModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      consola.info(
        t("CORE.OPENROUTER.DISCOVERED_FREE", {
          name: providerConfig.name,
          count: freeIds.length,
        }),
      );

      const enabledGlobs =
        getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
      const extras = enabledGlobs.filter(
        (g) => !g.includes("*") && !g.includes("?"),
      );
      const set = new Set(freeIds);
      for (const extra of extras) {
        if (!set.has(extra)) {
          set.add(extra);
          consola.debug(
            t("CORE.OPENROUTER.ADDED_EXTRA", {
              name: providerConfig.name,
              model: extra,
            }),
          );
        }
      }
      candidateIds = [...set];
    }

    if (candidateIds.length === 0) {
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return report;
    }

    const vendorFilter = providerConfig.enabledVendors;
    const filtered = candidateIds.filter((id) => {
      const bare = toBareName(id);
      if (
        matchesBlacklist(bare, config.blacklist, providerConfig.name) ||
        matchesBlacklist(id, config.blacklist, providerConfig.name)
      ) {
        return false;
      }
      if (vendorFilter?.length) {
        const slash = id.indexOf("/");
        const vendor = slash >= 0 ? id.slice(0, slash).toLowerCase() : "";
        if (!vendorFilter.map((v) => v.toLowerCase()).includes(vendor)) {
          return false;
        }
      }
      if (config.modelFilter?.length) {
        if (
          !matchesAnyPattern(id, config.modelFilter) &&
          !matchesAnyPattern(bare, config.modelFilter)
        ) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === 0) {
      report.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
      return report;
    }

    consola.info(
      t("CORE.OPENROUTER.PROBING", {
        name: providerConfig.name,
        count: filtered.length,
      }),
    );

    const filterResult = await testAndFilterModels({
      allModels: filtered,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      channelType: CHANNEL_TYPES.OPENAI,
      providerLabel: providerConfig.name,
      testableModelTypes: new Set(["text"]),
      acceptRateLimited: true,
    });
    const working = filterResult.workingModels;

    consola.info(
      t("CORE.OPENROUTER.WORKING", {
        name: providerConfig.name,
        working: working.length,
        total: filtered.length,
      }),
    );

    if (working.length === 0) {
      report.error = t("CORE.ERROR.NO_WORKING_MODELS");
      return report;
    }

    const resolutions = resolveBareNames(working, config.modelMapping);
    const exposedNames = resolutions.map((r) => r.exposed);
    const reverseMapping = buildChannelModelMapping(resolutions);

    const { vendorToModels } = pushPerVendorChannels({
      models: exposedNames,
      providerName: providerConfig.name,
      channelType: CHANNEL_TYPES.OPENROUTER,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      description: `OpenRouter via ${providerConfig.name}`,
      ratio: providerConfig.ratio,
      state,
      channelModelMapping:
        Object.keys(reverseMapping).length > 0 ? reverseMapping : undefined,
    });

    for (const exposed of exposedNames) {
      const existing = state.mergedModels.get(exposed);
      if (existing && (existing.ratio > 0 || (existing.modelPrice ?? 0) > 0)) {
        continue;
      }
      state.mergedModels.set(exposed, {
        ratio: 0,
        completionRatio: 0,
      });
    }

    consola.info(
      `[${providerConfig.name}] ${exposedNames.length} model(s) across ${vendorToModels.size} vendor channel(s)`,
    );

    report.groups = vendorToModels.size;
    report.models = exposedNames.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  return report;
}
