import {
  getEnabledModelGlobs,
  shouldSkipTesting,
  type ProviderConfig,
  type RuntimeConfig,
} from "@/config";
import {
  getTaskModelOverride,
  inferChannelTypeFromModels,
  inferModelType,
  inferVendorFromModelName,
  matchesAnyPattern,
  matchesBlacklist,
  normalizeEndpointTypes,
  sanitizeGroupName,
} from "@/lib/constants";
import { setTestCost, testAndFilterModels, type ModelTestDetail } from "@/lib/model-tester";
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
  // Blacklist only applies to text models — image/video/audio/embedding are never blacklisted
  let result = models.filter(
    (modelName) =>
      inferModelType(modelName) !== "text" ||
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

  const modelGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
  if (modelGlobs?.length) {
    result = result.filter((modelName) =>
      matchesAnyPattern(modelName, modelGlobs),
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
  groupChannelType: number;
  providerConfig: ProviderConfig;
  config: RuntimeConfig;
  state: SyncState;
  apiKey: string;
  testDetails?: ModelTestDetail[];
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

  // Create a channel per distinct ratio tier, splitting by required channel type
  // so video/image models that need specific adaptors get their own channels.
  let tierIdx = 0;
  for (const [effectiveRatio, { models, nonText }] of ratioToModels) {
    // Skip text model tiers that end up >= 1 after adjustment; non-text (image, video, etc.) are allowed above 1
    if (effectiveRatio >= 1 && !nonText) continue;

    // Sub-split models by required task channel type and base_url suffix.
    // Models needing a specific adaptor (sora, kling, veo, etc.) get separated;
    // the rest stay together with vendor-inferred channel type.
    // Key format: "channelType:suffix" or "default" for models without overrides.
    const subGroups = new Map<string, { models: string[]; channelType?: number; baseUrlSuffix?: string }>();
    for (const model of models) {
      const override = getTaskModelOverride(model);
      const key = override ? `${override.channelType}:${override.baseUrlSuffix ?? ""}` : "default";
      if (!subGroups.has(key)) subGroups.set(key, {
        models: [],
        channelType: override?.channelType,
        baseUrlSuffix: override?.baseUrlSuffix,
      });
      subGroups.get(key)!.models.push(model);
    }

    let subIdx = 0;
    for (const [, subGroup] of subGroups) {
      const { models: subModels, channelType: overrideType, baseUrlSuffix } = subGroup;
      const tierSuffix = ratioToModels.size > 1 || subGroups.size > 1
        ? `-t${tierIdx}${subGroups.size > 1 ? String.fromCharCode(97 + subIdx) : ""}`
        : "";
      const tierName = `${opts.sanitizedName}${tierSuffix}`;

      opts.state.mergedGroups.push({
        name: tierName,
        ratio: effectiveRatio,
        description: `${sanitizeGroupName(opts.groupName)} via ${opts.providerConfig.name}`,
        provider: opts.providerConfig.name,
      });

      // Use explicit task channel type, or infer from the sub-group's models
      const channelType = overrideType
        ?? inferChannelTypeFromModels(subModels, opts.state.modelEndpoints);

      // Apply base_url suffix for newapi providers with provider-specific paths
      const baseUrl = opts.providerConfig.baseUrl.replace(/\/$/, "")
        + (baseUrlSuffix ?? "");

      // Build per-tier model_mapping: only include models in this tier that were mapped
      const tierModelMapping: Record<string, string> = {};
      for (const model of subModels) {
        if (opts.reverseModelMapping[model]) {
          tierModelMapping[model] = opts.reverseModelMapping[model];
        }
      }

      // Aggregate capabilities from test details for models in this tier.
      let setting: string | undefined;
      if (opts.testDetails && opts.testDetails.length > 0) {
        const tierOriginalNames = subModels.map(
          (m) => opts.reverseModelMapping[m] ?? m,
        );
        const tierDetails = opts.testDetails.filter((d) =>
          tierOriginalNames.includes(d.model),
        );

        const capabilities: Record<string, boolean | null> = {};

        const toolResults = tierDetails
          .map((d) => d.toolCallSuccess)
          .filter((v) => v !== null && v !== undefined);
        if (toolResults.length > 0) {
          capabilities.tool_calling = toolResults.every(Boolean);
        }

        const streamResults = tierDetails
          .map((d) => d.streamSuccess)
          .filter((v) => v !== null && v !== undefined);
        if (streamResults.length > 0) {
          capabilities.streaming = streamResults.every(Boolean);
        }

        const httpResults = tierDetails
          .map((d) => d.success)
          .filter((v) => v !== null && v !== undefined);
        if (httpResults.length > 0) {
          capabilities.http = httpResults.every(Boolean);
        }

        if (Object.keys(capabilities).length > 0) {
          setting = JSON.stringify({ capabilities });
        }
      }

      opts.state.channelsToCreate.push({
        name: tierName,
        type: channelType,
        key: opts.apiKey,
        base_url: baseUrl,
        models: subModels.join(","),
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
        setting,
      });
      subIdx++;
    }
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
    const enabledGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
    if (enabledGlobs?.length) {
      groups = groups.filter((g) =>
        g.models.some((m) =>
          matchesAnyPattern(m, enabledGlobs),
        ),
      );
    }

    // Apply global blacklist to groups (by name or description).
    // When a group matches, only remove its text models — non-text models
    // (image/video/audio/embedding) are never affected by the blacklist.
    if (config.blacklist?.length) {
      for (const g of groups) {
        const nameHit = matchesBlacklist(g.name, config.blacklist, providerConfig.name);
        const descHit = matchesBlacklist(g.description, config.blacklist, providerConfig.name);
        if (nameHit || descHit) {
          g.models = g.models.filter((m) => inferModelType(m) !== "text");
        }
      }
      groups = groups.filter((g) => g.models.length > 0);
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
      (g) => g.ratio * effectiveMultiplier >= 1,
    );
    if (highRatioGroups.length > 0) {
      consola.info(
        `[${providerConfig.name}] Skipping ${highRatioGroups.length} group(s) with effective ratio >= 1: ${highRatioGroups.map((g) => `${g.name} (${g.ratio} × ${effectiveMultiplier.toFixed(2)} = ${(g.ratio * effectiveMultiplier).toFixed(2)})`).join(", ")}`,
      );
      groups = groups.filter((g) => g.ratio * effectiveMultiplier < 1);
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

    // Running balance across groups so per-model costs are accurate
    let runningBalance = startBalance;

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

      // Skip group if no models match filters
      if (candidateModels.length === 0) {
        continue;
      }

      // Test with original upstream model names (before mapping) so the
      // upstream provider recognises them.  Mapping is only for our target.
      const apiKey = tokenResult.tokens[group.name] ?? "";
      const modelCosts = new Map<string, number>();
      const filterResult = await testAndFilterModels({
        allModels: candidateModels,
        baseUrl: providerConfig.baseUrl,
        apiKey,
        channelType: group.channelType,
        providerLabel: `${providerConfig.name}/${group.name}`,
        skipTesting: shouldSkipTesting(config, providerConfig),
        modelEndpoints: state.modelEndpoints,
        onModelTested: async (detail) => {
          if (
            (!detail.success && detail.streamSuccess !== true) ||
            runningBalance === null
          )
            return;
          const bal = await upstream.fetchBalance();
          if (bal === null) return;
          const cost = runningBalance - bal;
          if (cost > 0) {
            modelCosts.set(
              detail.model,
              (modelCosts.get(detail.model) ?? 0) + cost,
            );
            runningBalance = bal;
            setTestCost(`${providerConfig.name}/${group.name}`, detail.model, cost);
          }
        },
      });

      // Log cost summary for this group (use mapped names for display)
      let costStr = "";
      if (modelCosts.size > 0) {
        const parts = [...modelCosts.entries()].map(
          ([model, cost]) => {
            const display = config.modelMapping?.[model] ?? model;
            return `${display} ${colorize("yellow", `$${cost.toFixed(4)}`)}`;
          },
        );
        costStr = ` | ${parts.join(", ")}`;
      }
      if (filterResult.testedCount > 0) {
        consola.info(
          `[${providerConfig.name}/${group.name}] ${filterResult.workingModels.length}/${filterResult.testedCount} working${costStr}`,
        );
      }

      // Now apply model mapping to working models and build the reverse map
      // for the channel (so the upstream translates mapped names back).
      const reverseModelMapping: Record<string, string> = {};
      let mappedModels = [
        ...new Set(
          filterResult.workingModels.map((m) => {
            const mapped = config.modelMapping?.[m] ?? m;
            if (mapped !== m) {
              reverseModelMapping[mapped] = m;
            }
            return mapped;
          }),
        ),
      ];

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
        groupChannelType: group.channelType,
        providerConfig,
        config,
        state,
        apiKey,
        testDetails: filterResult.details,
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
          quotaType: model.quotaType,
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
