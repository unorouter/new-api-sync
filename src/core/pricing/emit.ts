import type { Channel, MergedGroup, MergedModel } from "@core/types";
import { t } from "@server/i18n";
import type { BaselineInputs, PricedPlan, PricedTier } from "./types";

interface EmitArgs {
  plan: PricedPlan;
  baseline: BaselineInputs;
}

interface EmitResult {
  channels: Channel[];
  mergedGroups: MergedGroup[];
  mergedModels: Map<string, MergedModel>;
}

export function emitChannels(args: EmitArgs): EmitResult {
  const liveTiers = args.plan.tiers.filter((tier) => tier.models.length > 0);

  const seen = new Map<string, { source: "baseline" | "plan"; tag?: string }>();
  for (const ch of args.baseline.channels)
    seen.set(ch.name, { source: "baseline", tag: ch.tag });
  for (const tier of liveTiers) {
    const existing = seen.get(tier.channelName);
    if (existing) {
      throw new Error(
        t("ERROR.PRICING_CHANNEL_COLLISION", {
          name: tier.channelName,
          first:
            existing.source === "baseline"
              ? "baseline " + (existing.tag ?? "?")
              : "plan " + (existing.tag ?? "?"),
          second: tier.providerTag,
        }),
      );
    }
    seen.set(tier.channelName, { source: "plan", tag: tier.providerTag });
  }

  const channels: Channel[] = [];
  const mergedGroups: MergedGroup[] = [];

  for (const tier of liveTiers) {
    mergedGroups.push({
      name: tier.channelName,
      ratio: tier.groupRatio,
      description: tier.groupDescription,
      provider: tier.providerTag,
    });

    channels.push({
      name: tier.channelName,
      type: tier.channelType,
      key: tier.apiKey,
      base_url: tier.baseUrl,
      models: tier.models.join(","),
      group: tier.channelName,
      priority: 0,
      weight: 1,
      status: tier.disabled ? 3 : 1,
      tag: tier.providerTag,
      remark: tier.channelRemark,
      model_mapping:
        tier.modelMapping && Object.keys(tier.modelMapping).length > 0
          ? JSON.stringify(tier.modelMapping)
          : undefined,
      setting: buildSettingJson(tier),
      param_override: tier.paramOverride,
    });
  }

  return { channels, mergedGroups, mergedModels: args.plan.modelRatios };
}

function buildSettingJson(tier: PricedTier): string | undefined {
  const setting: Record<string, unknown> = {};

  if (tier.testDetails && tier.testDetails.length > 0) {
    const summarize = (
      pick: (
        d: NonNullable<PricedTier["testDetails"]>[number],
      ) => boolean | null | undefined,
    ): boolean | undefined => {
      const results = tier
        .testDetails!.map(pick)
        .filter((v): v is boolean => v !== null && v !== undefined);
      return results.length > 0 ? results.every(Boolean) : undefined;
    };

    // Skipped probes stay absent (new-api: missing = unknown = routable); `?? false` banned every
    // reasoning model (tool probe skipped) from tools requests via the channel_cache capability gate.
    const capabilities: Record<string, boolean> = {};
    const toolCalling = summarize((d) => d.toolCallSuccess);
    if (toolCalling !== undefined) capabilities.tool_calling = toolCalling;
    const streaming = summarize((d) => d.streamSuccess);
    if (streaming !== undefined) capabilities.streaming = streaming;
    const http = summarize((d) => d.success);
    if (http !== undefined) capabilities.http = http;
    if (Object.keys(capabilities).length > 0)
      setting.capabilities = capabilities;

    // Any probe that emitted reasoning_content -> convert thinking to visible content so a
    // reasoning-only turn is not billed as an empty (content-less) upstream 502.
    if (tier.testDetails.some((d) => d.thinkingDetected))
      setting.thinking_to_content = true;
  }

  if (tier.passThroughBody) setting.pass_through_body_enabled = true;

  if (tier.systemPrompt) {
    setting.system_prompt = tier.systemPrompt;
    if (tier.systemPromptOverride) setting.system_prompt_override = true;
  }

  return Object.keys(setting).length > 0 ? JSON.stringify(setting) : undefined;
}
