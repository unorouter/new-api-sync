import {
  getEnabledModelGlobs,
  getTestModelTypes,
  type RuntimeConfig,
} from "@core/config";
import {
  getTaskModelOverride,
  inferModelType,
  inferVendorFromModelName,
  matchesAnyPattern,
  matchesBlacklist,
  normalizeEndpointTypes,
  sanitizeGroupName,
} from "@core/models/constants";
import {
  setTestCost,
  testAndFilterModels,
  type ModelTestDetail,
} from "@core/models/tester";
import { resolvePriceAdjustment } from "@core/pricing";
import { throwIfRunAborted } from "@core/runtime/abort";
import type { GroupInfo, ProviderReport, SyncState } from "@core/types";
import type { ProviderConfig } from "@core/validations/config";
import { consola } from "consola";
import { colorize } from "consola/utils";
import { NewApiClient } from "./client";
import { probeChannelType } from "./probe-channel-type";

/**
 * Partition a flat model list into vendor buckets. Models without a known
 * vendor matcher land in `unknown` so they still get a channel.
 */
function partitionByVendor(models: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const model of models) {
    const vendor = inferVendorFromModelName(model) ?? "unknown";
    if (!out.has(vendor)) out.set(vendor, []);
    out.get(vendor)!.push(model);
  }
  return out;
}

function filterGroupModels(
  models: string[],
  config: RuntimeConfig,
  providerConfig: ProviderConfig,
  groupName: string,
): string[] {
  // Blacklist only applies to text models — image/video/audio/embedding are never blacklisted
  let result = models.filter(
    (modelName) =>
      inferModelType(modelName) !== "text" ||
      !matchesBlacklist(modelName, config.blacklist, providerConfig.name),
  );
  const blacklisted = models.filter((m) => !result.includes(m));
  if (blacklisted.length > 0) {
    consola.debug(
      `[${providerConfig.name}/${groupName}] Blacklisted: ${blacklisted.length}`,
    );
    consola.trace(
      `[${providerConfig.name}/${groupName}] Blacklisted models: ${blacklisted.join(", ")}`,
    );
  }

  if (providerConfig.enabledVendors?.length) {
    const vendorSet = new Set(
      providerConfig.enabledVendors.map((v) => v.toLowerCase()),
    );
    const before = result;
    result = result.filter((modelName) => {
      const vendor = inferVendorFromModelName(modelName);
      return vendor && vendorSet.has(vendor);
    });
    const vendorFiltered = before.filter((m) => !result.includes(m));
    if (vendorFiltered.length > 0) {
      consola.debug(
        `[${providerConfig.name}/${groupName}] Vendor-filtered: ${vendorFiltered.length}`,
      );
      consola.trace(
        `[${providerConfig.name}/${groupName}] Vendor-filtered (not in [${[...new Set(providerConfig.enabledVendors)].join(", ")}]): ${vendorFiltered.join(", ")}`,
      );
    }
  }

  const modelGlobs = getEnabledModelGlobs(providerConfig.enabledModels);
  if (modelGlobs?.length) {
    const before = result;
    result = result.filter((modelName) =>
      matchesAnyPattern(modelName, modelGlobs),
    );
    const globFiltered = before.filter((m) => !result.includes(m));
    if (globFiltered.length > 0) {
      consola.debug(
        `[${providerConfig.name}/${groupName}] Model-glob filtered: ${globFiltered.length}`,
      );
      consola.trace(
        `[${providerConfig.name}/${groupName}] Model-glob filtered (not matching [${modelGlobs.join(", ")}]): ${globFiltered.join(", ")}`,
      );
    }
  }

  if (config.modelFilter?.length) {
    const before = result;
    result = result.filter((modelName) =>
      matchesAnyPattern(modelName, config.modelFilter!),
    );
    const cliFiltered = before.filter((m) => !result.includes(m));
    if (cliFiltered.length > 0) {
      consola.debug(
        `[${providerConfig.name}/${groupName}] CLI-filtered: ${cliFiltered.length}`,
      );
      consola.trace(
        `[${providerConfig.name}/${groupName}] CLI-filtered (not matching [${config.modelFilter.join(", ")}]): ${cliFiltered.join(", ")}`,
      );
    }
  }

  consola.debug(
    `[${providerConfig.name}/${groupName}] ${models.length} → ${result.length} models after filters: ${result.join(", ") || "(none)"}`,
  );

  return result;
}

/**
 * Build channels for a single (group, vendor, channel-type) bucket. Splits
 * within the bucket by ratio tier and by task-model overrides (sora, kling,
 * etc.), producing channels named `<sanitizedName>-<vendor>` with `-tNa/-tNb`
 * suffixes only when sub-tiers exist.
 *
 * The bucket's `channelType` was already resolved by `probeChannelType`; this
 * function does not re-derive it. Task-model overrides can still flip a single
 * model into a vendor-specific channel-type (e.g. seedance → DOUBAO_VIDEO),
 * which short-circuits the bucket's probed shape for that model only.
 */
function buildVendorBucketChannels(opts: {
  vendor: string;
  channelType: number;
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
  testDetails?: ModelTestDetail[];
}): void {
  // Group models by their effective ratio (per-model/vendor/type priceAdjustment may differ).
  const ratioToModels = new Map<
    number,
    { models: string[]; nonText: boolean }
  >();
  for (const model of opts.mappedModels) {
    const modelType = inferModelType(
      model,
      undefined,
      opts.state.modelEndpoints,
    );
    const vendorAdj = resolvePriceAdjustment({
      adj: opts.providerConfig.priceAdjustment,
      model,
      vendor: opts.vendor,
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

  const skipUnprofitable =
    opts.config.skipUnprofitableText && !opts.config.isTestMode;

  // Vendor segment is always present in the channel name. Tier/sub-tier
  // suffixes only appear when there is more than one tier/sub-tier in the
  // bucket — single-tier vendor buckets stay clean (e.g. `aigc-deepseek`).
  const vendorSegment = `-${opts.vendor}`;

  let tierIdx = 0;
  for (const [effectiveRatio, { models, nonText }] of ratioToModels) {
    if (skipUnprofitable && effectiveRatio >= 1 && !nonText) continue;

    // Sub-split by task-model override. The name-based override only fires
    // when the upstream actually exposes the model as a task endpoint
    // (`openai-video`); otherwise resellers typically serve task-branded
    // models through plain `/v1/chat/completions`. When endpoint data is
    // missing we still apply the override as a best guess.
    const subGroups = new Map<
      string,
      { models: string[]; channelType?: number; baseUrlSuffix?: string }
    >();
    for (const model of models) {
      const eps = opts.state.modelEndpoints.get(model);
      const isTaskUpstream = eps ? eps.includes("openai-video") : true;
      const override = isTaskUpstream ? getTaskModelOverride(model) : undefined;
      const key = override
        ? `${override.channelType}:${override.baseUrlSuffix ?? ""}`
        : "default";
      if (!subGroups.has(key))
        subGroups.set(key, {
          models: [],
          channelType: override?.channelType,
          baseUrlSuffix: override?.baseUrlSuffix,
        });
      subGroups.get(key)!.models.push(model);
    }

    let subIdx = 0;
    for (const [, subGroup] of subGroups) {
      const {
        models: subModels,
        channelType: overrideType,
        baseUrlSuffix,
      } = subGroup;
      const tierSuffix =
        ratioToModels.size > 1 || subGroups.size > 1
          ? `-t${tierIdx}${subGroups.size > 1 ? String.fromCharCode(97 + subIdx) : ""}`
          : "";
      const tierName = `${opts.sanitizedName}${vendorSegment}${tierSuffix}`;

      opts.state.mergedGroups.push({
        name: tierName,
        ratio: effectiveRatio,
        description: `${sanitizeGroupName(opts.groupName)} via ${opts.providerConfig.name} (${opts.vendor})`,
        provider: opts.providerConfig.name,
      });

      // Task-model overrides win over the bucket's probed channel-type because
      // they target specific upstream endpoints (sora video, kling video, etc.)
      // that are not interchangeable with the generic shape.
      const channelType = overrideType ?? opts.channelType;

      const baseUrl =
        opts.providerConfig.baseUrl.replace(/\/$/, "") + (baseUrlSuffix ?? "");

      const tierModelMapping: Record<string, string> = {};
      for (const model of subModels) {
        if (opts.reverseModelMapping[model]) {
          tierModelMapping[model] = opts.reverseModelMapping[model];
        }
      }

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
        } else if (tierDetails.length > 0) {
          // Every model in the bucket reported `null` (e.g. reasoning-only
          // bucket where tool_choice is rejected). Mark the channel as
          // tool-incapable so tool-call requests get routed elsewhere
          // instead of 400ing here.
          capabilities.tool_calling = false;
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
    const suggestedGroups = pricing.groups.filter((g) =>
      g.models.some((m) => anthropicModels.has(m)),
    );

    if (suggestedGroups.length > 0) {
      consola.debug(
        `[${providerConfig.name}] Groups with Claude models: ${suggestedGroups.map((g) => g.name).join(", ")}`,
      );
    }

    let groups: GroupInfo[] = pricing.groups;

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
        g.models.some((m) => matchesAnyPattern(m, enabledGlobs)),
      );
    }

    // Apply global blacklist to groups (by name or description).
    // When a group matches, only remove its text models — non-text models
    // (image/video/audio/embedding) are never affected by the blacklist.
    if (config.blacklist?.length) {
      for (const g of groups) {
        const nameHit = matchesBlacklist(
          g.name,
          config.blacklist,
          providerConfig.name,
        );
        const descHit = matchesBlacklist(
          g.description,
          config.blacklist,
          providerConfig.name,
        );
        if (nameHit || descHit) {
          g.models = g.models.filter((m) => inferModelType(m) !== "text");
        }
      }
      groups = groups.filter((g) => g.models.length > 0);
    }

    // Skip groups whose effective ratio after priceAdjustment exceeds 1.
    // With per-vendor adjustments, use the lowest adjustment (biggest discount) to decide
    // whether the entire group is too expensive. Per-vendor filtering happens later.
    // In test mode this filter is bypassed so all groups get tested regardless of cost.
    // Disabled via config.skipUnprofitableText: false.
    if (!config.isTestMode && config.skipUnprofitableText) {
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
      throwIfRunAborted();
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
        group.name,
      );

      // Skip group if no models match filters
      if (candidateModels.length === 0) {
        continue;
      }

      // Test with original upstream model names (before mapping) so the
      // upstream provider recognises them.  Mapping is only for our target.
      const apiKey = tokenResult.tokens[group.name] ?? "";
      const modelCosts = new Map<string, number>();

      // Cost-capture callback shared across vendor sub-buckets within this
      // group: every model test (regardless of which vendor's probe shape it
      // ran under) deducts from the same running balance.
      const onModelTested = async (detail: ModelTestDetail) => {
        const hadBillableCall =
          detail.success ||
          detail.streamSuccess === true ||
          detail.authenticityProbed;
        if (!hadBillableCall || runningBalance === null) return;
        const bal = await upstream.fetchBalance();
        if (bal === null) return;
        const cost = runningBalance - bal;
        if (cost > 0) {
          modelCosts.set(
            detail.model,
            (modelCosts.get(detail.model) ?? 0) + cost,
          );
          runningBalance = bal;
          setTestCost(
            `${providerConfig.name}/${group.name}`,
            detail.model,
            cost,
          );
        }
      };

      // Partition the group's candidate models by vendor. Each vendor bucket
      // is probed independently to find a working endpoint shape, then its
      // models are tested under that shape, then a channel is built. This
      // isolates per-vendor brokenness on a reseller (e.g. aigcbest's
      // /v1/messages shim being broken for deepseek tool flows) from sibling
      // vendors that work fine.
      const vendorBuckets = partitionByVendor(candidateModels);
      let groupTotalTested = 0;
      let groupTotalWorking = 0;
      let groupHadAnyChannel = false;

      for (const [vendor, vendorModels] of vendorBuckets) {
        throwIfRunAborted();
        const probeLabel = `${providerConfig.name}/${group.name}`;

        const probe = await probeChannelType({
          baseUrl: providerConfig.baseUrl,
          apiKey,
          vendor,
          models: vendorModels,
          modelEndpoints: state.modelEndpoints,
          logPrefix: probeLabel,
        });

        if (!probe) {
          consola.warn(
            `[${probeLabel}] vendor=${vendor} probe failed; skipping ${vendorModels.length} models`,
          );
          continue;
        }

        const filterResult = await testAndFilterModels({
          allModels: vendorModels,
          baseUrl: providerConfig.baseUrl,
          apiKey,
          channelType: probe.channelType,
          providerLabel: `${probeLabel}/${vendor}`,
          testableModelTypes: getTestModelTypes(config, providerConfig),
          modelEndpoints: state.modelEndpoints,
          onModelTested,
        });

        groupTotalTested += filterResult.testedCount;
        groupTotalWorking += filterResult.workingModels.length;

        // Apply model mapping to working models and build the reverse map.
        const reverseModelMapping: Record<string, string> = {};
        const mappedModels = [
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

        if (mappedModels.length === 0) continue;

        buildVendorBucketChannels({
          vendor,
          channelType: probe.channelType,
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
          testDetails: filterResult.details,
        });
        groupHadAnyChannel = true;
      }

      // Log group-level cost and pass/total summary aggregated across vendors.
      let costStr = "";
      if (modelCosts.size > 0) {
        const parts = [...modelCosts.entries()].map(([model, cost]) => {
          const display = config.modelMapping?.[model] ?? model;
          return `${display} ${colorize("yellow", `$${cost.toFixed(4)}`)}`;
        });
        costStr = ` | ${parts.join(", ")}`;
      }
      if (groupTotalTested > 0) {
        consola.info(
          `[${providerConfig.name}/${group.name}] ${groupTotalWorking}/${groupTotalTested} working across ${vendorBuckets.size} vendors${costStr}`,
        );
      }

      if (!groupHadAnyChannel) {
        groupsWithNoWorkingModels.push(group.name);
      }
    }

    if (!config.isTestMode) {
      await cleanupEmptyGroupTokens(
        upstream,
        groupsWithNoWorkingModels,
        tokenPrefix,
        providerReport,
      );
    }

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
