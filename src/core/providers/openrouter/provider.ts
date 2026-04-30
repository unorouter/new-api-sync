import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import {
  buildChannelModelMapping,
  resolveBareNames,
  toBareName,
} from "@core/models/bare-name";
import {
  CHANNEL_TYPES,
  inferVendorFromModelName,
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
    let isFreeById = new Map<string, boolean>();

    if (providerConfig.models?.length) {
      candidateIds = [...providerConfig.models];
      // Without discovery we can't classify; assume :free suffix means free.
      for (const id of candidateIds) isFreeById.set(id, id.endsWith(":free"));
      consola.info(
        t("CORE.OPENROUTER.EXPLICIT_SKIP_DISCOVERY", {
          name: providerConfig.name,
          count: candidateIds.length,
        }),
      );
    } else {
      const catalogue = await discoverOpenRouterFreeModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      isFreeById = catalogue.isFreeById;
      consola.info(
        t("CORE.OPENROUTER.DISCOVERED_FREE", {
          name: providerConfig.name,
          count: catalogue.freeIds.length,
        }),
      );

      const enabledGlobs =
        getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
      const extras = enabledGlobs.filter(
        (g) => !g.includes("*") && !g.includes("?"),
      );
      const set = new Set(catalogue.freeIds);
      for (const extra of extras) {
        if (!set.has(extra)) {
          set.add(extra);
          // Catalogue may not contain extras; fall back to :free suffix.
          if (!isFreeById.has(extra)) {
            isFreeById.set(extra, extra.endsWith(":free"));
          }
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
    const reverseMapping = buildChannelModelMapping(resolutions);

    // Split into free and paid buckets. Default OpenRouter discovery only
    // returns free ids; paid ids enter exclusively via explicit `enabledModels`
    // entries. Paid models go into a separate `${name}-paid-${vendor}` channel
    // at ratio=1 so users actually pay for them; free stays at ratio=0.
    const freeResolutions = resolutions.filter(
      (r) => isFreeById.get(r.upstream) ?? r.upstream.endsWith(":free"),
    );
    const paidResolutions = resolutions.filter(
      (r) => !(isFreeById.get(r.upstream) ?? r.upstream.endsWith(":free")),
    );

    let totalVendors = 0;

    if (freeResolutions.length > 0) {
      const exposed = freeResolutions.map((r) => r.exposed);
      const { vendorToModels } = pushPerVendorChannels({
        models: exposed,
        providerName: providerConfig.name,
        channelType: CHANNEL_TYPES.OPENROUTER,
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        description: `OpenRouter free via ${providerConfig.name}`,
        ratio: providerConfig.ratio,
        state,
        channelModelMapping:
          Object.keys(reverseMapping).length > 0 ? reverseMapping : undefined,
      });
      totalVendors += vendorToModels.size;

      // Force-zero pricing for free models so they don't accidentally get
      // billed when canonical retail data later supplies a non-zero ratio.
      for (const r of freeResolutions) {
        const existing = state.mergedModels.get(r.exposed);
        if (existing && (existing.ratio > 0 || (existing.modelPrice ?? 0) > 0)) {
          continue;
        }
        state.mergedModels.set(r.exposed, {
          ratio: 0,
          completionRatio: 0,
        });
      }
    }

    if (paidResolutions.length > 0) {
      // Group paid models per-vendor and pick a per-vendor `groupRatio` such
      // that `model_ratio × groupRatio` lands close to canonical retail. The
      // group must still be a single ratio per channel, so we use the lowest
      // ratio that keeps every model within `maxRatioCap × canonical`. Any
      // model that can't fit (canonical too low even at min ratio) is dropped.
      const cap = providerConfig.maxRatioCap ?? config.maxRatioCap;
      const paidByVendor = new Map<string, typeof paidResolutions>();
      for (const r of paidResolutions) {
        const vendor = inferVendorFromModelName(r.exposed) ?? "other";
        if (!paidByVendor.has(vendor)) paidByVendor.set(vendor, []);
        paidByVendor.get(vendor)!.push(r);
      }

      let paidVendors = 0;
      for (const [vendor, vendorResolutions] of paidByVendor) {
        // For each candidate group_ratio (1.0, 0.5, 0.1, 0.01), include
        // only models whose `model_ratio × ratio ≤ canonical × cap`.
        // Pick the highest ratio that keeps at least one model.
        const candidates = [1, 0.5, 0.25, 0.1, 0.05, 0.01];
        let chosen: { ratio: number; kept: typeof vendorResolutions } | null =
          null;
        for (const ratio of candidates) {
          const kept = vendorResolutions.filter((r) => {
            const merged = state.mergedModels.get(r.exposed);
            const modelRatio = merged?.ratio ?? 1;
            const canonical = state.canonicalLookup(r.exposed);
            const ceiling = (canonical ?? modelRatio) * cap;
            return modelRatio * ratio <= ceiling;
          });
          if (kept.length === vendorResolutions.length) {
            chosen = { ratio, kept };
            break;
          }
          if (kept.length > 0 && !chosen) {
            chosen = { ratio, kept };
          }
        }
        if (!chosen || chosen.kept.length === 0) {
          for (const r of vendorResolutions) {
            consola.info(
              `[pricing] drop ${r.exposed} ${providerConfig.name}-paid/${vendor} no group_ratio fits within cap=${cap}x`,
            );
          }
          continue;
        }

        const channelName = `${providerConfig.name}-paid-${vendor}`;
        state.mergedGroups.push({
          name: channelName,
          ratio: chosen.ratio,
          description: `OpenRouter paid via ${providerConfig.name}`,
          provider: providerConfig.name,
        });

        const exposed = chosen.kept.map((r) => r.exposed);
        const scopedMapping: Record<string, string> = {};
        for (const r of chosen.kept) {
          const upstream = reverseMapping[r.exposed];
          if (upstream !== undefined) {
            scopedMapping[r.exposed] = upstream;
          }
        }
        state.channelsToCreate.push({
          name: channelName,
          type: CHANNEL_TYPES.OPENROUTER,
          key: providerConfig.apiKey,
          base_url: providerConfig.baseUrl.replace(/\/$/, ""),
          models: exposed.join(","),
          group: channelName,
          priority: 0,
          weight: 1,
          status: 1,
          tag: providerConfig.name,
          remark: channelName,
          model_mapping:
            Object.keys(scopedMapping).length > 0
              ? JSON.stringify(scopedMapping)
              : undefined,
        });
        paidVendors++;
        for (const r of chosen.kept) {
          const merged = state.mergedModels.get(r.exposed);
          const modelRatio = merged?.ratio ?? 1;
          const canonical = state.canonicalLookup(r.exposed);
          consola.debug(
            `[pricing] paid ${r.exposed} ${channelName} model_ratio=${modelRatio} group_ratio=${chosen.ratio} → $${(modelRatio * chosen.ratio * 2).toFixed(2)}/M (canonical $${canonical !== undefined ? (canonical * 2).toFixed(2) : "?"}/M)`,
          );
        }
        const dropped = vendorResolutions.filter(
          (r) => !chosen!.kept.includes(r),
        );
        for (const r of dropped) {
          consola.info(
            `[pricing] drop ${r.exposed} ${channelName} exceeds cap=${cap}x at chosen group_ratio=${chosen.ratio}`,
          );
        }
      }
      totalVendors += paidVendors;
    }

    consola.info(
      `[${providerConfig.name}] ${resolutions.length} model(s) (${freeResolutions.length} free, ${paidResolutions.length} paid) across ${totalVendors} vendor channel(s)`,
    );

    report.groups = totalVendors;
    report.models = resolutions.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  return report;
}
