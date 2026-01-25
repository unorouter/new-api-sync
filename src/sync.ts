import { NekoClient } from "@/clients/neko-client";
import { NewApiClient } from "@/clients/newapi-client";
import { TargetClient } from "@/clients/target-client";
import { validateConfig } from "@/lib/config";
import { logInfo, sanitizeGroupName } from "@/lib/utils";
import type {
  Channel,
  Config,
  GroupInfo,
  MergedGroup,
  MergedModel,
  ModelInfo,
  NekoProviderConfig,
  ProviderConfig,
  ProviderReport,
  SyncReport
} from "@/types";
import { isNekoProvider } from "@/types";

export async function sync(config: Config): Promise<SyncReport> {
  const startTime = Date.now();
  validateConfig(config);

  const report: SyncReport = {
    success: true,
    providers: [],
    channels: { created: 0, updated: 0, deleted: 0 },
    options: { updated: [] },
    errors: [],
    timestamp: new Date(),
  };

  const mergedGroups: MergedGroup[] = [];
  const mergedModels = new Map<string, MergedModel>();
  const upstreamModels: ModelInfo[] = [];
  const upstreamVendorIdToName: Record<number, string> = {};
  const channelsToCreate: Array<{
    name: string;
    type: number;
    key: string;
    baseUrl: string;
    models: string[];
    group: string;
    priority: number;
    weight: number;
    provider: string;
    remark: string;
  }> = [];

  // Text endpoint types from new-api (openai, anthropic, gemini, openai-response)
  // Non-text types: image-generation, embeddings, openai-video, jina-rerank
  const textEndpointTypes = new Set([
    "openai", "anthropic", "gemini", "openai-response",
  ]);

  // Fallback patterns for providers that don't return endpoint types (e.g., neko)
  const nonTextModelPatterns = [
    "sora", "veo", "video", "image", "dall-e", "dalle", "midjourney",
    "stable-diffusion", "flux", "imagen", "whisper", "tts", "speech",
    "embedding", "embed", "moderation", "rerank",
  ];

  // Map to store model endpoint types from upstream pricing
  const modelEndpoints = new Map<string, string[]>();

  function isTextModel(name: string, endpoints?: string[]): boolean {
    const n = name.toLowerCase();

    // Always check pattern matching first - catches misclassified models from upstream
    const matchesNonText = nonTextModelPatterns.some((pattern) => n.includes(pattern));
    if (matchesNonText) return false;

    // If we have endpoint info from API, also verify it has text endpoints
    const modelEps = endpoints ?? modelEndpoints.get(name);
    if (modelEps && modelEps.length > 0) {
      // Model must have at least one text endpoint type
      return modelEps.some((ep) => textEndpointTypes.has(ep));
    }

    // No endpoint info and no pattern match - assume text model
    return true;
  }

  // Infer vendor from model name for filtering and vendor assignment
  function inferVendorFromModelName(name: string): string | undefined {
    // Skip non-text models
    if (!isTextModel(name)) return undefined;

    const n = name.toLowerCase();
    if (n.includes("claude") || n.includes("anthropic")) return "anthropic";
    if (n.includes("gemini") || n.includes("palm")) return "google";
    if (n.includes("gpt") || n.includes("o1-") || n.includes("o3-") || n.includes("o4-") || n.startsWith("chatgpt")) return "openai";
    if (n.includes("deepseek")) return "deepseek";
    if (n.includes("grok")) return "xai";
    if (n.includes("mistral") || n.includes("codestral")) return "mistral";
    if (n.includes("llama") || n.includes("meta-")) return "meta";
    if (n.includes("qwen")) return "alibaba";
    return undefined;
  }

  // Check if a group has models from any of the enabled vendors
  function groupHasEnabledVendor(group: GroupInfo, enabledVendors: string[]): boolean {
    const vendorSet = new Set(enabledVendors.map((v) => v.toLowerCase()));
    return group.models.some((modelName) => {
      const vendor = inferVendorFromModelName(modelName);
      return vendor && vendorSet.has(vendor);
    });
  }

  // Check if a model matches any of the enabled model patterns (partial match)
  function modelMatchesPatterns(modelName: string, patterns: string[]): boolean {
    const n = modelName.toLowerCase();
    return patterns.some((pattern) => n.includes(pattern.toLowerCase()));
  }

  for (const providerConfig of config.providers) {
    const providerReport: ProviderReport = {
      name: providerConfig.name,
      success: false,
      groups: 0,
      models: 0,
      tokens: { created: 0, existing: 0, deleted: 0 },
    };

    try {
      const isNeko = isNekoProvider(providerConfig);
      const upstream = isNeko
        ? new NekoClient(providerConfig as NekoProviderConfig)
        : new NewApiClient(providerConfig as ProviderConfig);

      const startBalance = await upstream.fetchBalance();
      const pricing = await upstream.fetchPricing();
      logInfo(`[${providerConfig.name}] Balance: ${startBalance}`);
      let currentBalance = parseFloat(startBalance.replace(/[^0-9.-]/g, ""));

      // Populate model endpoints map for text model detection
      for (const model of pricing.models) {
        if (model.supportedEndpoints?.length) {
          modelEndpoints.set(model.name, model.supportedEndpoints);
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
        logInfo(
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
        groups = groups.filter((g) =>
          groupHasEnabledVendor(g, providerConfig.enabledVendors!),
        );
      }

      const tokenResult = await upstream.ensureTokens(
        groups,
        providerConfig.name,
      );
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

        // Always filter out non-text models first
        const nonTextModels = group.models.filter((modelName) => !isTextModel(modelName));
        let workingModels = group.models.filter((modelName) => isTextModel(modelName));
        if (nonTextModels.length > 0) {
          logInfo(
            `[${providerConfig.name}/${group.name}] Filtered ${nonTextModels.length} non-text models: ${nonTextModels.slice(0, 5).join(", ")}${nonTextModels.length > 5 ? "..." : ""}`,
          );
        }

        // Then filter by enabled vendors if specified
        if (providerConfig.enabledVendors?.length) {
          const vendorSet = new Set(providerConfig.enabledVendors.map((v) => v.toLowerCase()));
          workingModels = workingModels.filter((modelName) => {
            const vendor = inferVendorFromModelName(modelName);
            return vendor && vendorSet.has(vendor);
          });
        }

        // Filter by enabled models if specified (partial match)
        if (providerConfig.enabledModels?.length) {
          workingModels = workingModels.filter((modelName) =>
            modelMatchesPatterns(modelName, providerConfig.enabledModels!),
          );
        }

        // Skip group if no models match filters
        if (workingModels.length === 0) {
          continue;
        }

        // Test models if option is enabled
        let avgResponseTime: number | undefined;
        if (config.options?.testModels) {
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

            const failedCount = group.models.length - workingModels.length;
            const costStr = testCost > 0 ? ` | Cost: $${testCost.toFixed(4)}` : "";
            const testedCount = workingModels.length + failedCount;

            if (workingModels.length === 0) {
              logInfo(
                `[${providerConfig.name}/${group.name}] ${testedCount}/${testedCount} models failed testing${costStr}`,
              );
              logInfo(
                `[${providerConfig.name}/${group.name}] Skipping - no working models`,
              );
              groupsWithNoWorkingModels.push(group.name);
              continue;
            }

            // Build summary: working/total, response time, cost
            const parts: string[] = [];
            if (failedCount > 0) {
              parts.push(`${workingModels.length}/${testedCount} working`);
            } else {
              parts.push(`${workingModels.length} models`);
            }
            if (avgResponseTime !== undefined) {
              const bonus = Math.round(10000 / (avgResponseTime + 100));
              parts.push(`${Math.round(avgResponseTime)}ms → +${bonus}`);
            }
            if (testCost > 0) {
              parts.push(`$${testCost.toFixed(4)}`);
            }
            logInfo(`[${providerConfig.name}/${group.name}] ${parts.join(" | ")}`);
          }
        }

        // Apply priceMultiplier to group ratio for per-provider billing
        if (providerConfig.priceMultiplier) {
          groupRatio *= providerConfig.priceMultiplier;
        }

        // Calculate dynamic priority and weight: faster response = higher values
        // Formula: basePriority + bonus where bonus = 10000 / (avgResponseTime + 100)
        // ~100ms → +50, ~400ms → +20, ~900ms → +10
        const basePriority = providerConfig.priority ?? 0;
        const responseBonus =
          avgResponseTime !== undefined
            ? Math.round(10000 / (avgResponseTime + 100))
            : 0;
        const dynamicPriority = basePriority + responseBonus;
        const dynamicWeight = responseBonus > 0 ? responseBonus : 1;

        mergedGroups.push({
          name: sanitizedName,
          ratio: groupRatio,
          description: `${sanitizeGroupName(group.name)} via ${providerConfig.name}`,
          provider: providerConfig.name,
        });
        channelsToCreate.push({
          name: sanitizedName,
          type: group.channelType,
          key: tokenResult.tokens[group.name] ?? "",
          baseUrl: providerConfig.baseUrl,
          models: workingModels,
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
        const existing = mergedModels.get(model.name);
        if (!existing || model.ratio < existing.ratio) {
          mergedModels.set(model.name, {
            ratio: model.ratio,
            completionRatio: model.completionRatio,
          });
        }
        if (!upstreamModels.find((m) => m.name === model.name)) {
          upstreamModels.push(model);
        }
      }

      Object.assign(upstreamVendorIdToName, pricing.vendorIdToName);

      providerReport.groups = groups.length;
      providerReport.models = pricing.models.length;
      providerReport.success = true;

      // Log final balance and total test cost
      if (config.options?.testModels && totalTestCost > 0) {
        const finalBalance = await upstream.fetchBalance();
        logInfo(
          `[${providerConfig.name}] Final balance: ${finalBalance} | Total test cost: $${totalTestCost.toFixed(4)}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerReport.error = message;
      report.errors.push({
        provider: providerConfig.name,
        phase: "fetch",
        message,
      });
      console.error(`Provider ${providerConfig.name} failed: ${message}`);
    }

    report.providers.push(providerReport);
  }

  if (mergedGroups.length === 0) {
    console.error("No groups collected from any provider");
    report.success = false;
    report.errors.push({ phase: "collect", message: "No groups collected" });
    return report;
  }

  const groupRatio = Object.fromEntries(
    mergedGroups.map((g) => [g.name, g.ratio]),
  );
  const autoGroups = [...mergedGroups]
    .sort((a, b) => a.ratio - b.ratio)
    .map((g) => g.name);
  const usableGroups: Record<string, string> = {
    auto: "Auto (Smart Routing with Failover)",
  };
  for (const group of mergedGroups) {
    usableGroups[group.name] = group.description;
  }
  const modelRatio = Object.fromEntries(
    [...mergedModels.entries()].map(([k, v]) => [k, v.ratio]),
  );
  const completionRatio = Object.fromEntries(
    [...mergedModels.entries()].map(([k, v]) => [k, v.completionRatio]),
  );

  const target = new TargetClient(config.target);

  const optionsResult = await target.updateOptions({
    GroupRatio: JSON.stringify(groupRatio),
    UserUsableGroups: JSON.stringify(usableGroups),
    AutoGroups: JSON.stringify(autoGroups),
    DefaultUseAutoGroup: "true",
    ModelRatio: JSON.stringify(modelRatio),
    CompletionRatio: JSON.stringify(completionRatio),
  });

  report.options.updated = optionsResult.updated;
  for (const key of optionsResult.failed) {
    report.errors.push({
      phase: "options",
      message: `Failed to update option: ${key}`,
    });
  }

  const existingChannels = await target.listChannels();
  const existingByName = new Map(existingChannels.map((c) => [c.name, c]));
  const desiredChannelNames = new Set(channelsToCreate.map((c) => c.name));

  for (const spec of channelsToCreate) {
    const existing = existingByName.get(spec.name);
    const channelData: Channel = {
      name: spec.name,
      type: spec.type,
      key: spec.key,
      base_url: spec.baseUrl.replace(/\/$/, ""),
      models: spec.models.join(","),
      group: spec.group,
      priority: spec.priority,
      weight: spec.weight,
      status: 1,
      tag: spec.provider,
      remark: spec.remark,
    };

    if (existing) {
      channelData.id = existing.id;
      const success = await target.updateChannel(channelData);
      if (success) {
        report.channels.updated++;
      } else {
        report.errors.push({
          phase: "channels",
          message: `Failed to update channel: ${spec.name}`,
        });
      }
    } else {
      const id = await target.createChannel(channelData);
      if (id !== null) {
        report.channels.created++;
      } else {
        report.errors.push({
          phase: "channels",
          message: `Failed to create channel: ${spec.name}`,
        });
      }
    }
  }

  if (config.options?.deleteStaleChannels !== false) {
    for (const channel of existingChannels) {
      if (desiredChannelNames.has(channel.name)) continue;
      // Delete if: channel has a tag (managed by sync) AND either:
      // 1. Tag matches a configured provider (stale channel from current provider)
      // 2. Tag doesn't match any configured provider (orphan from removed provider)
      if (channel.tag) {
        const success = await target.deleteChannel(channel.id!);
        if (success) {
          report.channels.deleted++;
        } else {
          report.errors.push({
            phase: "channels",
            message: `Failed to delete channel: ${channel.name}`,
          });
        }
      }
    }
  }

  const existingModels = await target.listModels();
  const existingModelsByName = new Map(existingModels.map((m) => [m.model_name, m]));
  const modelsToSync = new Set<string>();
  for (const channel of channelsToCreate) {
    for (const model of channel.models) {
      modelsToSync.add(model);
    }
  }

  const targetVendors = await target.listVendors();
  const vendorNameToTargetId: Record<string, number> = {};
  for (const v of targetVendors) {
    vendorNameToTargetId[v.name.toLowerCase()] = v.id;
  }

  let modelsCreated = 0;
  let modelsUpdated = 0;
  for (const modelName of modelsToSync) {
    const inferredVendor = inferVendorFromModelName(modelName);
    const targetVendorId = inferredVendor
      ? vendorNameToTargetId[inferredVendor]
      : undefined;

    const existing = existingModelsByName.get(modelName);
    if (existing) {
      if (existing.vendor_id !== targetVendorId) {
        const success = await target.updateModel({
          ...existing,
          vendor_id: targetVendorId,
        });
        if (success) {
          modelsUpdated++;
        }
      }
    } else {
      const success = await target.createModel({
        model_name: modelName,
        vendor_id: targetVendorId,
        status: 1,
        sync_official: 1,
      });
      if (success) {
        modelsCreated++;
      }
    }
  }

  let modelsDeleted = 0;
  for (const model of existingModels) {
    if (model.sync_official === 1 && !modelsToSync.has(model.model_name)) {
      if (model.id && (await target.deleteModel(model.id))) {
        modelsDeleted++;
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  report.success = report.errors.length === 0;

  console.log(
    `Done in ${elapsed}s | Providers: ${report.providers.filter((p) => p.success).length}/${report.providers.length} | Channels: +${report.channels.created} ~${report.channels.updated} -${report.channels.deleted} | Models: +${modelsCreated} ~${modelsUpdated} -${modelsDeleted}`,
  );

  // Log cost per channel (model ratios)
  console.log("\n--- Channel Cost Summary ---");
  for (const channel of channelsToCreate) {
    const modelCosts: { model: string; ratio: number }[] = [];
    let totalRatio = 0;
    for (const modelName of channel.models) {
      const modelData = mergedModels.get(modelName);
      if (modelData) {
        modelCosts.push({ model: modelName, ratio: modelData.ratio });
        totalRatio += modelData.ratio;
      }
    }
    const avgRatio = channel.models.length > 0 ? totalRatio / channel.models.length : 0;
    const topModels = modelCosts
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 3)
      .map((m) => `${m.model}:${m.ratio.toFixed(2)}`)
      .join(", ");
    console.log(
      `[${channel.provider}/${channel.group}] ${channel.models.length} models | Avg ratio: ${avgRatio.toFixed(2)} | Top: ${topModels}`,
    );
  }

  if (report.errors.length > 0) {
    for (const err of report.errors) {
      console.error(`[${err.provider ?? "target"}/${err.phase}] ${err.message}`);
    }
  }

  return report;
}
