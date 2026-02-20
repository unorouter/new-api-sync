import type { RuntimeConfig } from "@/config";
import {
  inferChannelTypeFromModels,
  inferVendorFromModelName,
  isTestableModel,
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName
} from "@/lib/constants";
import type {
  GroupInfo,
  ProviderConfig,
  ProviderReport,
  SyncState
} from "@/lib/types";
import { consola } from "consola";
import { NewApiClient } from "./client";

export async function processNewApiProvider(
  providerConfig: ProviderConfig,
  config: RuntimeConfig,
  state: SyncState
): Promise<ProviderReport> {
  const providerReport: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 }
  };

  try {
    const upstream = new NewApiClient(providerConfig);

    const pricing = await upstream.fetchPricing();

    // Populate model endpoints map for text model detection
    for (const model of pricing.models) {
      if (model.supportedEndpoints?.length) {
        state.modelEndpoints.set(model.name, model.supportedEndpoints);
      }
    }

    // Find groups with Anthropic models that aren't in config
    const anthropicModels = new Set(
      pricing.models
        .filter(
          (m) => m.name.toLowerCase().includes("claude") || m.vendorId === 2
        )
        .map((m) => m.name)
    );
    const enabledSet = new Set(providerConfig.enabledGroups ?? []);
    const suggestedGroups = pricing.groups.filter((g) => {
      const hasAnthropicModel = g.models.some((m) => anthropicModels.has(m));
      const notEnabled = !enabledSet.has(g.name);
      return hasAnthropicModel && notEnabled;
    });

    if (suggestedGroups.length > 0 && providerConfig.enabledGroups?.length) {
      consola.info(
        `[${providerConfig.name}] Groups with Claude models (not in config): ${suggestedGroups.map((g) => g.name).join(", ")}`
      );
    }

    let groups: GroupInfo[] = pricing.groups;

    // Filter by enabledGroups if specified
    if (providerConfig.enabledGroups?.length) {
      groups = groups.filter((g) =>
        providerConfig.enabledGroups!.includes(g.name)
      );
    }

    // Filter by enabledVendors if specified
    if (providerConfig.enabledVendors?.length) {
      const vendorSet = new Set(providerConfig.enabledVendors.map((v) => v.toLowerCase()));
      groups = groups.filter((g) =>
        g.models.some((m) => {
          const vendor = inferVendorFromModelName(m);
          return vendor && vendorSet.has(vendor);
        })
      );
    }

    // Filter by enabledModels if specified — skip groups that don't contain
    // any model matching the patterns, so we don't create unnecessary tokens.
    if (providerConfig.enabledModels?.length) {
      groups = groups.filter((g) =>
        g.models.some((m) =>
          matchesAnyPattern(m, providerConfig.enabledModels!)
        )
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
            providerConfig.name
          )
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
      (g) => g.ratio * effectiveMultiplier > 1
    );
    if (highRatioGroups.length > 0) {
      consola.info(
        `[${providerConfig.name}] Skipping ${highRatioGroups.length} group(s) with effective ratio > 1: ${highRatioGroups.map((g) => `${g.name} (${g.ratio} × ${effectiveMultiplier.toFixed(2)} = ${(g.ratio * effectiveMultiplier).toFixed(2)})`).join(", ")}`
      );
      groups = groups.filter((g) => g.ratio * effectiveMultiplier <= 1);
    }

    const tokenResult = await upstream.ensureTokens(
      groups,
      providerConfig.name
    );
    providerReport.tokens = {
      created: tokenResult.created,
      existing: tokenResult.existing,
      deleted: tokenResult.deleted
    };

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

      // Filter out blacklisted models
      let candidateModels = group.models.filter(
        (modelName) =>
          !matchesBlacklist(modelName, config.blacklist, providerConfig.name)
      );

      // Then filter by enabled vendors if specified
      if (providerConfig.enabledVendors?.length) {
        const vendorSet = new Set(
          providerConfig.enabledVendors.map((v) => v.toLowerCase())
        );
        candidateModels = candidateModels.filter((modelName) => {
          const vendor = inferVendorFromModelName(modelName);
          return vendor && vendorSet.has(vendor);
        });
      }

      // Filter by enabled models if specified (glob patterns supported)
      if (providerConfig.enabledModels?.length) {
        candidateModels = candidateModels.filter((modelName) =>
          matchesAnyPattern(modelName, providerConfig.enabledModels!)
        );
      }

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
          })
        )
      ];

      // Skip group if no models match filters
      if (mappedModels.length === 0) {
        continue;
      }

      // Partition into testable (text endpoints) and non-testable (image-only, etc.)
      const testableModels = mappedModels.filter((m) =>
        isTestableModel(m, undefined, state.modelEndpoints)
      );
      const nonTestableModels = mappedModels.filter(
        (m) => !isTestableModel(m, undefined, state.modelEndpoints)
      );

      // Test only models that support text endpoints
      const apiKey = tokenResult.tokens[group.name] ?? "";
      const testedCount = testableModels.length;
      let testedWorkingModels: string[] = [];
      if (apiKey && testableModels.length > 0) {
        const testResult = await upstream.testModelsWithKey(
          apiKey,
          testableModels,
          group.channelType
        );
        const failedModels = testableModels.filter(
          (m) => !testResult.workingModels.includes(m)
        );
        testedWorkingModels = testResult.workingModels;

        if (failedModels.length > 0) {
          consola.info(
            `[${providerConfig.name}/${group.name}] Failed: ${failedModels.join(", ")}`
          );
        }

        consola.info(
          `[${providerConfig.name}/${group.name}] ${testedWorkingModels.length}/${testedCount} working`
        );
      }

      // Combine tested working models with non-testable models (included without testing)
      mappedModels = [...testedWorkingModels, ...nonTestableModels];

      if (nonTestableModels.length > 0) {
        consola.info(
          `[${providerConfig.name}/${group.name}] Included without test: ${nonTestableModels.join(", ")}`
        );
      }

      if (mappedModels.length === 0) {
        consola.info(
          `[${providerConfig.name}/${group.name}] 0/${testedCount} | skip`
        );
        groupsWithNoWorkingModels.push(group.name);
        continue;
      }

      // Group models by their effective ratio (per-vendor priceAdjustment may differ)
      const ratioToModels = new Map<number, string[]>();
      for (const model of mappedModels) {
        const vendor = inferVendorFromModelName(model) ?? "unknown";
        const adj = providerConfig.priceAdjustment;
        const vendorAdj = adj === undefined ? 0
          : typeof adj === "number" ? adj
          : adj[vendor.toLowerCase()] ?? adj["default"] ?? 0;
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
          provider: providerConfig.name
        });

        // Infer channel type from the actual filtered models' vendor names
        const channelType = inferChannelTypeFromModels(
          models,
          state.modelEndpoints
        );

        // Build per-tier model_mapping: only include models in this tier that were mapped
        const tierModelMapping: Record<string, string> = {};
        for (const model of models) {
          if (reverseModelMapping[model]) {
            tierModelMapping[model] = reverseModelMapping[model];
          }
        }

        state.channelsToCreate.push({
          name: tierName,
          type: channelType,
          key: tokenResult.tokens[group.name] ?? "",
          baseUrl: providerConfig.baseUrl,
          models,
          group: tierName,
          priority: 0,
          weight: 1,
          provider: providerConfig.name,
          remark: originalName,
          modelMapping:
            Object.keys(tierModelMapping).length > 0
              ? tierModelMapping
              : undefined
        });
        tierIdx++;
      }
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
          modelPrice: model.modelPrice
        });
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
