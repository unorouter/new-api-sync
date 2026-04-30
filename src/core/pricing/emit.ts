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
        `Channel name collision: "${tier.channelName}" produced twice ` +
          `(${existing.source === "baseline" ? "baseline " + (existing.tag ?? "?") : "plan " + (existing.tag ?? "?")} ` +
          `and plan ${tier.providerTag}). ` +
          `Each (provider, group, vendor, ratio-tier, base-url-suffix) bucket ` +
          `must produce a unique channel name.`,
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
  const capabilities: Record<string, boolean | null> = {};

  const toolResults = tier.testDetails
    .map((d) => d.toolCallSuccess)
    .filter((v): v is boolean => v !== null && v !== undefined);
  if (toolResults.length > 0) {
    capabilities.tool_calling = toolResults.every(Boolean);
  } else {
    capabilities.tool_calling = false;
  }

  const streamResults = tier.testDetails
    .map((d) => d.streamSuccess)
    .filter((v): v is boolean => v !== null && v !== undefined);
  if (streamResults.length > 0) {
    capabilities.streaming = streamResults.every(Boolean);
  }

  const httpResults = tier.testDetails
    .map((d) => d.success)
    .filter((v): v is boolean => v !== null && v !== undefined);
  if (httpResults.length > 0) {
    capabilities.http = httpResults.every(Boolean);
  }

  if (Object.keys(capabilities).length === 0) return undefined;
  return JSON.stringify({ capabilities });
}
