import {
  shouldSkipTesting,
  type ProviderConfig,
  type RuntimeConfig,
} from "@/config";
import {
  inferChannelTypeFromModels,
  inferModelType,
  inferVendorFromModelName,
  matchesAnyPattern,
  matchesBlacklist,
  normalizeEndpointTypes,
  sanitizeGroupName,
} from "@/lib/constants";
import { testAndFilterModels } from "@/lib/model-tester";
import { resolvePriceAdjustment } from "@/lib/pricing";
import type { GroupInfo, ProviderReport, SyncState } from "@/lib/types";
import { consola } from "consola";
import { colorize } from "consola/utils";
import { NewApiClient } from "./client";

function filterGroupModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: ProviderConfig,
): string[] {
  let result = models.filter(
    (modelName) =>
      !matchesBlacklist(modelName, config.blacklist, providerConfig.name),
  );

  if (providerConfig.enabledVendors?.length) {
    const vendorSet = new Set(
      providerConfig.enabledVendors.map((v) => v.toLowerCase()),
    );
    result = result.filter((modelName) => {
      const vendor = inferVendorFromModelName(modelName);
      return vendor && vendorSet.has(vendor);
    });
  }

  if (providerConfig.enabledModels?.length) {
    result = result.filter((modelName) =>
      matchesAnyPattern(modelName, providerConfig.enabledModels!),
    );
  }

  return result;
}

function buildGroupChannels(opts: {
  mappedModels: string[];
  reverseModelMapping: Record<string, string>;
  groupRatio: number;
  groupName: string;
  sanitizedName: string;
  channelRemark: string;
  providerConfig: ProviderConfig;
  config: RuntimeConfig;
  state: SyncState;
  apiKey: string;
}): void {
  // Group models by their effective ratio (per-model/vendor/type priceAdjustment may differ)
  const ratioToModels = new Map<
    number,
    { models: string[]; nonText: boolean }
  >();
  for (const model of opts.mappedModels) {
    const vendor = inferVendorFromModelName(model) ?? "unknown";
    const modelType = inferModelType(
      model,
      undefined,
      opts.state.modelEndpoints,
    );
    const vendorAdj = resolvePriceAdjustment({
      adj: opts.providerConfig.priceAdjustment,
      model,
      vendor,
      modelType,
      fallback: 0,
      modelMapping: opts.config.modelMapping,
    });
    const effectiveRatio = opts.groupRatio * (1 + vendorAdj);
    const key = Math.round(effectiveRatio * 1e6) / 1e6;
    if (!ratioToModels.has(key))
      ratioToModels.set(key, { models: [], nonText: modelType !== "text" });
    ratioToModels.get(key)!.models.push(model);
  }

  // Create a channel per distinct ratio tier
  let tierIdx = 0;
  for (const [effectiveRatio, { models, nonText }] of ratioToModels) {
    // Skip text model tiers that end up > 1 after adjustment; non-text (image, video, etc.) are allowed above 1
    if (effectiveRatio > 1 && !nonText) continue;

    const suffix = ratioToModels.size > 1 ? `-t${tierIdx}` : "";
    const tierName = `${opts.sanitizedName}${suffix}`;

    opts.state.mergedGroups.push({
      name: tierName,
      ratio: effectiveRatio,
      description: `${sanitizeGroupName(opts.groupName)} via ${opts.providerConfig.name}`,
      provider: opts.providerConfig.name,
    });

    const channelType = inferChannelTypeFromModels(
      models,
      opts.state.modelEndpoints,
    );

    // Build per-tier model_mapping: only include models in this tier that were mapped
    const tierModelMapping: Record<string, string> = {};
    for (const model of models) {
      if (opts.reverseModelMapping[model]) {
        tierModelMapping[model] = opts.reverseModelMapping[model];
      }
    }

    opts.state.channelsToCreate.push({
      name: tierName,
      type: channelType,
      key: opts.apiKey,
      base_url: opts.providerConfig.baseUrl.replace(/\/$/, ""),
      models: models.join(","),
      group: tierName,
      priority: 0,
      weight: 1,
      status: 1,
      tag: opts.providerConfig.name,
      remark: opts.channelRemark,
      model_mapping:
        Object.keys(tierModelMapping).length > 0
          ? JSON.stringify(tierModelMapping)
          : undefined,
    });
    tierIdx++;
  }
}

async function cleanupEmptyGroupTokens(
  upstream: NewApiClient,
  groupNames: string[],
  tokenPrefix: string,
  report: ProviderReport,
): Promise<void> {
  if (groupNames.length === 0) return;
  const allTokens = await upstream.listTokens();
  for (const groupName of groupNames) {
    const tokenName = `${groupName}-${tokenPrefix}`;
    const token = allTokens.find((t) => t.name === tokenName);
    if (token && (await upstream.deleteToken(token.id))) {
      report.tokens.deleted++;
    }
  }
}

export async function processNewApiProvider(
  providerConfig: ProviderConfig,
  config: RuntimeConfig,
  state: SyncState,
): Promise<ProviderReport> {
  const providerReport: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };

  try {
    const upstream = new NewApiClient(providerConfig, providerConfig.name);

    const pricing = await upstream.fetchPricing();

    // Populate model endpoints maps
    for (const model of pricing.models) {
      if (model.supportedEndpoints?.length) {
        state.modelEndpoints.set(
          model.name,
          normalizeEndpointTypes(model.supportedEndpoints),
        );
        state.modelOriginalEndpoints.set(model.name, model.supportedEndpoints);
      }
    }

    // Store real endpoint paths from the upstream's supported_endpoint map (original keys only)
    for (const [ep, info] of Object.entries(pricing.endpointPaths)) {
      state.endpointPaths.set(ep, info);
    }

    // Find groups with Anthropic models that aren't in config
    const anthropicModels = new Set(
      pricing.models
        .filter(
          (m) => m.name.toLowerCase().includes("claude") || m.vendorId === 2,
        )
        .map((m) => m.name),
    );
    const enabledSet = new Set(providerConfig.enabledGroups ?? []);
    const suggestedGroups = pricing.groups.filter((g) => {
      const hasAnthropicModel = g.models.some((m) => anthropicModels.has(m));
      const notEnabled = !enabledSet.has(g.name);
      return hasAnthropicModel && notEnabled;
    });

    if (suggestedGroups.length > 0 && providerConfig.enabledGroups?.length) {
      consola.info(
        `[${providerConfig.name}] Groups with Claude models (not in config): ${suggestedGroups.map((g) => g.name).join(", ")}`,
      );
    }

    let groups: GroupInfo[] = pricing.groups;

    // Filter by enabledGroups if specified
    if (providerConfig.enabledGroups?.length) {
      groups = groups.filter((g) =>
        providerConfig.enabledGroups!.includes(g.name),
      );
    }

    // Filter by enabledVendors if specified
    if (providerConfig.enabledVendors?.length) {
      const vendorSet = new Set(
        providerConfig.enabledVendors.map((v) => v.toLowerCase()),
      );
      groups = groups.filter((g) =>
        g.models.some((m) => {
          const vendor = inferVendorFromModelName(m);
          return vendor && vendorSet.has(vendor);
        }),
      );
    }

    // Filter by enabledModels if specified — skip groups that don't contain
    // any model matching the patterns, so we don't create unnecessary tokens.
    if (providerConfig.enabledModels?.length) {
      groups = groups.filter((g) =>
        g.models.some((m) =>
          matchesAnyPattern(m, providerConfig.enabledModels!),
        ),
      );
    }

    // Apply global blacklist to groups (by name or description)
    if (config.blacklist?.length) {
      groups = groups.filter(
        (g) =>
          !matchesBlacklist(g.name, config.blacklist, providerConfig.name) &&
          !matchesBlacklist(
            g.description,
            config.blacklist,
            providerConfig.name,
          ),
      );
    }

    // Skip groups whose effective ratio after priceAdjustment exceeds 1.
    // With per-vendor adjustments, use the lowest adjustment (biggest discount) to decide
    // whether the entire group is too expensive. Per-vendor filtering happens later.
    const adj = providerConfig.priceAdjustment;
    const minAdjustment =
      adj === undefined
        ? 0
        : typeof adj === "number"
          ? adj
          : Math.min(...Object.values(adj));
    const effectiveMultiplier = 1 + minAdjustment;
    const highRatioGroups = groups.filter(
      (g) => g.ratio * effectiveMultiplier > 1,
    );
    if (highRatioGroups.length > 0) {
      consola.info(
        `[${providerConfig.name}] Skipping ${highRatioGroups.length} group(s) with effective ratio > 1: ${highRatioGroups.map((g) => `${g.name} (${g.ratio} × ${effectiveMultiplier.toFixed(2)} = ${(g.ratio * effectiveMultiplier).toFixed(2)})`).join(", ")}`,
      );
      groups = groups.filter((g) => g.ratio * effectiveMultiplier <= 1);
    }

    const tokenPrefix = config.target.targetPrefix ?? providerConfig.name;
    const tokenResult = await upstream.ensureTokens(groups, tokenPrefix);
    providerReport.tokens = {
      created: tokenResult.created,
      existing: tokenResult.existing,
      deleted: tokenResult.deleted,
    };

    // Fetch balance before testing for cost tracking
    const startBalance = await upstream.fetchBalance();
    if (startBalance !== null) {
      consola.info(
        `[${providerConfig.name}] Balance: $${startBalance.toFixed(4)}`,
      );
    }

    // Track groups with no working models to delete their tokens later
    const groupsWithNoWorkingModels: string[] = [];

    // Track used sanitized names to disambiguate collisions from Chinese-only group names
    const usedSanitizedNames = new Map<string, number>();

    for (const group of groups) {
      const originalName = `${group.name}-${providerConfig.name}`;
      let sanitizedName = sanitizeGroupName(originalName);

      // Deduplicate: if this sanitized name was already used, append -2, -3, etc.
      const count = usedSanitizedNames.get(sanitizedName) ?? 0;
      usedSanitizedNames.set(sanitizedName, count + 1);
      if (count > 0) {
        sanitizedName = `${sanitizedName}-${count + 1}`;
      }
      const groupRatio = group.ratio;

      const candidateModels = filterGroupModels(
        group.models,
        config,
        providerConfig,
      );

      // Apply model mapping and build reverse map for the channel.
      // The channel's model_mapping tells the upstream to translate the mapped
      // (target-facing) name back to the original (upstream-facing) name.
      const reverseModelMapping: Record<string, string> = {};
      let mappedModels = [
        ...new Set(
          candidateModels.map((m) => {
            const mapped = config.modelMapping?.[m] ?? m;
            if (mapped !== m) {
              reverseModelMapping[mapped] = m;
            }
            return mapped;
          }),
        ),
      ];

      // Skip group if no models match filters
      if (mappedModels.length === 0) {
        continue;
      }

      const apiKey = tokenResult.tokens[group.name] ?? "";
      const modelCosts = new Map<string, number>();
      let groupBalanceBefore = startBalance;
      const filterResult = await testAndFilterModels({
        allModels: mappedModels,
        baseUrl: providerConfig.baseUrl,
        apiKey,
        channelType: group.channelType,
        providerLabel: `${providerConfig.name}/${group.name}`,
        skipTesting: shouldSkipTesting(config, providerConfig),
        modelEndpoints: state.modelEndpoints,
        onModelTested: async (detail) => {
          if (
            (!detail.success && detail.streamSuccess !== true) ||
            groupBalanceBefore === null
          )
            return;
          const bal = await upstream.fetchBalance();
          if (bal === null) return;
          const cost = groupBalanceBefore - bal;
          if (cost > 0) {
            modelCosts.set(
              detail.model,
              (modelCosts.get(detail.model) ?? 0) + cost,
            );
            groupBalanceBefore = bal;
          }
        },
      });

      // Log cost summary for this group
      let costStr = "";
      if (modelCosts.size > 0) {
        const parts = [...modelCosts.entries()].map(
          ([model, cost]) =>
            `${model} ${colorize("yellow", `$${cost.toFixed(4)}`)}`,
        );
        costStr = ` | ${parts.join(", ")}`;
      }
      if (filterResult.testedCount > 0) {
        consola.info(
          `[${providerConfig.name}/${group.name}] ${filterResult.workingModels.length}/${filterResult.testedCount} working${costStr}`,
        );
      }

      mappedModels = filterResult.workingModels;

      if (mappedModels.length === 0) {
        groupsWithNoWorkingModels.push(group.name);
        continue;
      }

      buildGroupChannels({
        mappedModels,
        reverseModelMapping,
        groupRatio,
        groupName: group.name,
        sanitizedName,
        channelRemark: originalName,
        providerConfig,
        config,
        state,
        apiKey,
      });
    }

    await cleanupEmptyGroupTokens(
      upstream,
      groupsWithNoWorkingModels,
      tokenPrefix,
      providerReport,
    );

    for (const model of pricing.models) {
      const existing = state.mergedModels.get(model.name);
      if (!existing || model.ratio < existing.ratio) {
        state.mergedModels.set(model.name, {
          ratio: model.ratio,
          completionRatio: model.completionRatio,
          modelPrice: model.modelPrice,
        });
      }
    }

    // Log final balance and test cost
    if (startBalance !== null) {
      const finalBalance = await upstream.fetchBalance();
      if (finalBalance !== null) {
        const cost = startBalance - finalBalance;
        const costStr =
          cost > 0
            ? ` | Test cost: ${colorize("yellow", `$${cost.toFixed(4)}`)}`
            : "";
        consola.info(
          `[${providerConfig.name}] Balance: $${finalBalance.toFixed(4)}${costStr}`,
        );
      }
    }

    providerReport.groups = groups.length;
    providerReport.models = pricing.models.length;
    providerReport.success = true;
  } catch (error) {
    providerReport.error =
      error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
