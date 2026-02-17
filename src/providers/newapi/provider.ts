import {
  applyModelMapping,
  calculatePriorityBonus,
  inferChannelTypeFromModels,
  inferVendorFromModelName,
  isTextModel,
  matchesAnyPattern,
  matchesBlacklist,
  resolvePriceAdjustment,
  sanitizeGroupName,
} from "@/lib/constants";
import type {
  Config,
  GroupInfo,
  ProviderConfig,
  ProviderReport,
  SyncState,
} from "@/lib/types";
import { consola } from "consola";
import { colorize } from "consola/utils";
import { NewApiClient } from "./client";

function groupHasEnabledVendor(group: GroupInfo, enabledVendors: string[]): boolean {
  const vendorSet = new Set(enabledVendors.map((v) => v.toLowerCase()));
  return group.models.some((modelName) => {
    const vendor = inferVendorFromModelName(modelName);
    return vendor && vendorSet.has(vendor);
  });
}

export async function processNewApiProvider(
  providerConfig: ProviderConfig,
  config: Config,
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
    const upstream = new NewApiClient(providerConfig);

    const startBalance = await upstream.fetchBalance();
    const pricing = await upstream.fetchPricing();
    consola.info(`[${providerConfig.name}] Balance: ${startBalance}`);
    let currentBalance = parseFloat(startBalance.replace(/[^0-9.-]/g, ""));

    // Populate model endpoints map for text model detection
    for (const model of pricing.models) {
      if (model.supportedEndpoints?.length) {
        state.modelEndpoints.set(model.name, model.supportedEndpoints);
      }
    }

    // Find groups with Anthropic models that aren't in config
    const anthropicModels = new Set(
      pricing.models
        .filter((m) => m.name.toLowerCase().includes("claude") || m.vendorId === 2)
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
      groups = groups.filter((g) => providerConfig.enabledGroups!.includes(g.name));
    }

    // Filter by enabledVendors if specified
    if (providerConfig.enabledVendors?.length) {
      groups = groups.filter((g) =>
        groupHasEnabledVendor(g, providerConfig.enabledVendors!),
      );
    }

    // Apply global blacklist to groups (by name or description)
    if (config.blacklist?.length) {
      groups = groups.filter(
        (g) =>
          !matchesBlacklist(g.name, config.blacklist, providerConfig.name) &&
          !matchesBlacklist(g.description, config.blacklist, providerConfig.name),
      );
    }

    // Skip groups whose effective ratio after priceAdjustment exceeds 1.
    // With per-vendor adjustments, use the lowest adjustment (biggest discount) to decide
    // whether the entire group is too expensive. Per-vendor filtering happens later.
    const adj = providerConfig.priceAdjustment;
    const minAdjustment = adj === undefined ? 0
      : typeof adj === "number" ? adj
      : Math.min(...Object.values(adj));
    const effectiveMultiplier = 1 + minAdjustment;
    const highRatioGroups = groups.filter((g) => g.ratio * effectiveMultiplier > 1);
    if (highRatioGroups.length > 0) {
      consola.info(
        `[${providerConfig.name}] Skipping ${highRatioGroups.length} group(s) with effective ratio > 1: ${highRatioGroups.map((g) => `${g.name} (${g.ratio} × ${effectiveMultiplier.toFixed(2)} = ${(g.ratio * effectiveMultiplier).toFixed(2)})`).join(", ")}`,
      );
      groups = groups.filter((g) => g.ratio * effectiveMultiplier <= 1);
    }

    const tokenResult = await upstream.ensureTokens(groups, providerConfig.name);
    providerReport.tokens = {
      created: tokenResult.created,
      existing: tokenResult.existing,
      deleted: tokenResult.deleted,
    };

    // Track groups with no working models to delete their tokens later
    const groupsWithNoWorkingModels: string[] = [];
    let totalTestCost = 0;

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

      // Always filter out non-text models and blacklisted models first
      let workingModels = group.models.filter(
        (modelName) =>
          isTextModel(modelName, undefined, state.modelEndpoints) &&
          !matchesBlacklist(modelName, config.blacklist, providerConfig.name),
      );

      // Then filter by enabled vendors if specified
      if (providerConfig.enabledVendors?.length) {
        const vendorSet = new Set(providerConfig.enabledVendors.map((v) => v.toLowerCase()));
        workingModels = workingModels.filter((modelName) => {
          const vendor = inferVendorFromModelName(modelName);
          return vendor && vendorSet.has(vendor);
        });
      }

      // Filter by enabled models if specified (glob patterns supported)
      if (providerConfig.enabledModels?.length) {
        workingModels = workingModels.filter((modelName) =>
          matchesAnyPattern(modelName, providerConfig.enabledModels!),
        );
      }

      // Apply model mapping early and deduplicate: we need to test the final
      // (mapped) model names since those are what actually get sent upstream.
      // e.g. gpt-5.2-medium maps to gpt-5.2, and we must test gpt-5.2 works.
      let mappedModels = [...new Set(
        workingModels.map((m) => applyModelMapping(m, config.modelMapping)),
      )];

      // Skip group if no models match filters
      if (mappedModels.length === 0) {
        continue;
      }

      // Test models using mapped names (the actual names sent to upstream)
      let avgResponseTime: number | undefined;
      const apiKey = tokenResult.tokens[group.name] ?? "";
      const testedCount = mappedModels.length;
      if (apiKey) {
        // Track per-model cost by checking balance after each model test
        const modelCosts = new Map<string, number>();
        const testResult = await upstream.testModelsWithKey(
          apiKey,
          mappedModels,
          group.channelType,
          async (detail) => {
            if (!detail.success) return;
            const newBalanceStr = await upstream.fetchBalance();
            const newBalance = parseFloat(newBalanceStr.replace(/[^0-9.-]/g, ""));
            const cost = currentBalance - newBalance;
            if (cost > 0) {
              modelCosts.set(detail.model, (modelCosts.get(detail.model) ?? 0) + cost);
              totalTestCost += cost;
              currentBalance = newBalance;
            }
          },
        );
        const failedModels = mappedModels.filter((m) => !testResult.workingModels.includes(m));
        mappedModels = testResult.workingModels;
        avgResponseTime = testResult.avgResponseTime;

        const testCost = [...modelCosts.values()].reduce((a, b) => a + b, 0);
        const bonus = calculatePriorityBonus(avgResponseTime);
        const msStr = avgResponseTime !== undefined ? `${Math.round(avgResponseTime)}ms` : "-";

        // Format per-model cost breakdown when group has cost
        let costStr = `$${testCost.toFixed(4)}`;
        if (testCost > 0) {
          const parts = [...modelCosts.entries()].map(
            ([model, cost]) => `${model} ${colorize("yellow", `$${cost.toFixed(4)}`)}`,
          );
          costStr = parts.join(", ");
        }

        if (mappedModels.length === 0) {
          consola.info(
            `[${providerConfig.name}/${group.name}] 0/${testedCount} | ${msStr} | ${costStr} | skip`,
          );
          groupsWithNoWorkingModels.push(group.name);
          continue;
        }

        if (failedModels.length > 0) {
          consola.info(
            `[${providerConfig.name}/${group.name}] Failed: ${failedModels.join(", ")}`,
          );
        }

        consola.info(
          `[${providerConfig.name}/${group.name}] ${mappedModels.length}/${testedCount} | ${msStr} → +${bonus} | ${costStr}`,
        );
      }

      // Calculate dynamic priority and weight: faster response = higher values
      const dynamicPriority = calculatePriorityBonus(avgResponseTime);
      const dynamicWeight = dynamicPriority > 0 ? dynamicPriority : 1;

      // Group models by their effective ratio (per-vendor priceAdjustment may differ)
      const ratioToModels = new Map<number, string[]>();
      for (const model of mappedModels) {
        const vendor = inferVendorFromModelName(model) ?? "unknown";
        const vendorAdj = resolvePriceAdjustment(providerConfig.priceAdjustment, vendor);
        const effectiveRatio = groupRatio * (1 + vendorAdj);
        const key = Math.round(effectiveRatio * 1e6) / 1e6;
        if (!ratioToModels.has(key)) ratioToModels.set(key, []);
        ratioToModels.get(key)!.push(model);
      }

      // Create a channel per distinct ratio tier
      let tierIdx = 0;
      for (const [effectiveRatio, models] of ratioToModels) {
        // Skip vendor subsets that end up > 1 after per-vendor adjustment
        if (effectiveRatio > 1) continue;

        const suffix = ratioToModels.size > 1 ? `-t${tierIdx}` : "";
        const tierName = `${sanitizedName}${suffix}`;

        state.mergedGroups.push({
          name: tierName,
          ratio: effectiveRatio,
          description: `${sanitizeGroupName(group.name)} via ${providerConfig.name}`,
          provider: providerConfig.name,
        });

        // Infer channel type from the actual filtered models' vendor names
        const channelType = inferChannelTypeFromModels(models, state.modelEndpoints);

        state.channelsToCreate.push({
          name: tierName,
          type: channelType,
          key: tokenResult.tokens[group.name] ?? "",
          baseUrl: providerConfig.baseUrl,
          models,
          group: tierName,
          priority: dynamicPriority,
          weight: dynamicWeight,
          provider: providerConfig.name,
          remark: originalName,
        });
        tierIdx++;
      }
    }

    // Delete tokens for groups with no working models
    for (const groupName of groupsWithNoWorkingModels) {
      const tokenName = sanitizeGroupName(`${groupName}-${providerConfig.name}`);
      const deleted = await upstream.deleteTokenByName(tokenName);
      if (deleted) {
        providerReport.tokens.deleted++;
      }
    }

    for (const model of pricing.models) {
      const existing = state.mergedModels.get(model.name);
      if (!existing || model.ratio < existing.ratio) {
        state.mergedModels.set(model.name, {
          ratio: model.ratio,
          completionRatio: model.completionRatio,
        });
      }
    }

    providerReport.groups = groups.length;
    providerReport.models = pricing.models.length;
    providerReport.success = true;

    // Log final balance and total test cost
    if (totalTestCost > 0) {
      const finalBalance = await upstream.fetchBalance();
      consola.info(
        `[${providerConfig.name}] Final balance: ${finalBalance} | Total test cost: $${totalTestCost.toFixed(4)}`,
      );
    }
  } catch (error) {
    providerReport.error = error instanceof Error ? error.message : String(error);
  }

  return providerReport;
}
