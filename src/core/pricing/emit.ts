// emitChannels: translate a PricedPlan into Channel[] + global state.
//
// Pricing math is done by compute(); this is purely a translation step:
// PricedTier → Channel, plus the mergedGroups list buildOptionMaps reads,
// plus a collision check across the union of baseline channels and the new
// plan's tiers.
//
// The capabilities JSON (`{"capabilities": {...}}`) for channel.setting is
// built here from tier.testDetails. emit owns this concern because it's
// downstream of pricing and depends on per-tier filtering already done by
// compute when it pushed the tier.

import type { Channel, MergedGroup, MergedModel } from "@core/types";
import { t } from "@server/i18n";
import type { PricedPlan, PricedTier } from "./types";
import type { BaselineInputs } from "./types";

export interface EmitArgs {
  plan: PricedPlan;
  baseline: BaselineInputs;
}

export interface EmitResult {
  channels: Channel[];
  mergedGroups: MergedGroup[];
  mergedModels: Map<string, MergedModel>;
}

export function emitChannels(args: EmitArgs): EmitResult {
  const { plan, baseline } = args;

  // Collision detection across baseline channels (unmanaged) + new tiers.
  // Same error format as the previous in-pipeline check so on-call greps
  // still work.
  const seen = new Map<string, { source: "baseline" | "plan"; tag?: string }>();
  for (const ch of baseline.channels) {
    seen.set(ch.name, { source: "baseline", tag: ch.tag });
  }
  for (const tier of plan.tiers) {
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

  for (const tier of plan.tiers) {
    mergedGroups.push({
      name: tier.channelName,
      ratio: tier.groupRatio,
      description: tier.groupDescription,
      provider: tier.providerTag,
    });

    const setting = buildSettingJson(tier);

    channels.push({
      name: tier.channelName,
      type: tier.channelType,
      key: tier.apiKey,
      base_url: tier.baseUrl,
      models: tier.models.join(","),
      group: tier.channelName,
      priority: 0,
      weight: 1,
      status: 1,
      tag: tier.providerTag,
      remark: tier.channelRemark,
      model_mapping:
        tier.modelMapping && Object.keys(tier.modelMapping).length > 0
          ? JSON.stringify(tier.modelMapping)
          : undefined,
      setting,
    });
  }

  return {
    channels,
    mergedGroups,
    mergedModels: plan.modelRatios,
  };
}

// ---------------------------------------------------------------------------
// Capabilities JSON for channel.setting.
//
// Match the legacy format exactly: {"capabilities": {tool_calling, streaming, http}}.
// Each field is true iff every test detail in the tier reports a non-null
// success for that probe. The "tool_calling = false when all-null" branch
// matches the old behaviour where reasoning-only buckets get marked
// tool-incapable so they don't 400 on tool-call requests routed here.
// ---------------------------------------------------------------------------

function buildSettingJson(tier: PricedTier): string | undefined {
  if (!tier.testDetails || tier.testDetails.length === 0) return undefined;

  const summarize = (
    pick: (d: NonNullable<PricedTier["testDetails"]>[number]) => boolean | null | undefined,
  ): boolean | undefined => {
    const results = tier.testDetails!
      .map(pick)
      .filter((v): v is boolean => v !== null && v !== undefined);
    return results.length > 0 ? results.every(Boolean) : undefined;
  };

  const capabilities: Record<string, boolean> = {
    // tool_calling=false when all test results were null — matches legacy
    // behaviour: reasoning-only buckets get marked tool-incapable so they
    // don't 400 on tool-call requests routed here.
    tool_calling: summarize((d) => d.toolCallSuccess) ?? false,
  };
  const streaming = summarize((d) => d.streamSuccess);
  if (streaming !== undefined) capabilities.streaming = streaming;
  const http = summarize((d) => d.success);
  if (http !== undefined) capabilities.http = http;

  return JSON.stringify({ capabilities });
}
