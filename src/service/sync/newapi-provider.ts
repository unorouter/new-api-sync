import { NewApiClient } from "@/clients/newapi-client";
import {
  applyModelMapping,
  calculatePriorityBonus,
  inferVendorFromModelName,
  isTextModel,
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@/lib/constants";
import type {
  Config,
  GroupInfo,
  ProviderConfig,
  ProviderReport,
  SyncReport,
} from "@/lib/types";
import { consola } from "consola";
import type { SyncState } from "./types";

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
  report: SyncReport,
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
          !matchesBlacklist(g.name, config.blacklist) &&
          !matchesBlacklist(g.description, config.blacklist),
      );
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

    for (const group of groups) {
      const originalName = `${group.name}-${providerConfig.name}`;
      const sanitizedName = sanitizeGroupName(originalName);
      let groupRatio = group.ratio;

      // Always filter out non-text models and blacklisted models first
      let workingModels = group.models.filter(
        (modelName) =>
          isTextModel(modelName, undefined, state.modelEndpoints) &&
          !matchesBlacklist(modelName, config.blacklist),
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

      // Skip group if no models match filters
      if (workingModels.length === 0) {
        continue;
      }

      // Test models
      let avgResponseTime: number | undefined;
      const apiKey = tokenResult.tokens[group.name] ?? "";
      if (apiKey) {
        const testResult = await upstream.testModelsWithKey(
          apiKey,
          workingModels,
          group.channelType,
        );
        workingModels = testResult.workingModels;
        avgResponseTime = testResult.avgResponseTime;

        // Calculate test cost by fetching new balance
        const newBalanceStr = await upstream.fetchBalance();
        const newBalance = parseFloat(newBalanceStr.replace(/[^0-9.-]/g, ""));
        const testCost = currentBalance - newBalance;
        if (testCost > 0) {
          totalTestCost += testCost;
          currentBalance = newBalance;
        }

        const testedCount = workingModels.length + (group.models.length - workingModels.length);
        const bonus = calculatePriorityBonus(avgResponseTime);
        const msStr = avgResponseTime !== undefined ? `${Math.round(avgResponseTime)}ms` : "-";

        if (workingModels.length === 0) {
          consola.info(
            `[${providerConfig.name}/${group.name}] 0/${testedCount} | ${msStr} | $${testCost.toFixed(4)} | skip`,
          );
          groupsWithNoWorkingModels.push(group.name);
          continue;
        }

        consola.info(
          `[${providerConfig.name}/${group.name}] ${workingModels.length}/${testedCount} | ${msStr} → +${bonus} | $${testCost.toFixed(4)}`,
        );
      }

      // Apply priceMultiplier to group ratio for per-provider billing
      if (providerConfig.priceMultiplier) {
        groupRatio *= providerConfig.priceMultiplier;
      }

      // Calculate dynamic priority and weight: faster response = higher values
      const dynamicPriority = calculatePriorityBonus(avgResponseTime);
      const dynamicWeight = dynamicPriority > 0 ? dynamicPriority : 1;

      // Apply model name mapping if configured
      const mappedModels = workingModels.map((m) =>
        applyModelMapping(m, config.modelMapping),
      );

      state.mergedGroups.push({
        name: sanitizedName,
        ratio: groupRatio,
        description: `${sanitizeGroupName(group.name)} via ${providerConfig.name}`,
        provider: providerConfig.name,
      });
      state.channelsToCreate.push({
        name: sanitizedName,
        type: group.channelType,
        key: tokenResult.tokens[group.name] ?? "",
        baseUrl: providerConfig.baseUrl,
        models: mappedModels,
        group: sanitizedName,
        priority: dynamicPriority,
        weight: dynamicWeight,
        provider: providerConfig.name,
        remark: originalName,
      });
    }

    // Delete tokens for groups with no working models
    for (const groupName of groupsWithNoWorkingModels) {
      const tokenName = `${groupName}-${providerConfig.name}`;
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
