// No remote catalog; one channel per aihorde block, model list from config.
// Bypasses pricing/emit; synthesizes Channel directly (mirrors comfyui/provider.ts).
// The Go AIHorde task adapter reads per-model default params from workflow_templates.

import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import type { Channel, ProviderReport } from "@core/types";
import type { AIHordeProviderConfig } from "@core/validations/config";

export function buildAIHordeChannels(providerConfig: AIHordeProviderConfig): {
  channels: Channel[];
  report: ProviderReport;
} {
  const report: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };

  const modelNames = Object.keys(providerConfig.models);
  if (modelNames.length === 0) {
    report.error = "aihorde: no models defined";
    return { channels: [], report };
  }

  const baseUrl = (providerConfig.baseUrl ?? "https://aihorde.net").replace(
    /\/$/,
    "",
  );
  const channelName =
    providerConfig.channelName ?? sanitizeGroupName(providerConfig.name);
  const tag = providerConfig.channelTag ?? providerConfig.name;

  // Adapter expects { models: { <published-id>: {defaults...} } }. Strip `price`
  // (that lives in ModelPrice, not the adapter body); pass the gen params through.
  const models: Record<string, Record<string, unknown>> = {};
  for (const [name, m] of Object.entries(providerConfig.models)) {
    models[name] = {
      ...(m.hordeModel ? { horde_model: m.hordeModel } : {}),
      ...(m.width ? { width: m.width } : {}),
      ...(m.height ? { height: m.height } : {}),
      ...(m.steps ? { steps: m.steps } : {}),
      ...(m.cfgScale ? { cfg_scale: m.cfgScale } : {}),
      ...(m.samplerName ? { sampler_name: m.samplerName } : {}),
      ...(m.karras !== undefined ? { karras: m.karras } : {}),
      ...(m.clipSkip ? { clip_skip: m.clipSkip } : {}),
    };
  }

  const channel: Channel = {
    name: channelName,
    type: CHANNEL_TYPES.AIHORDE,
    key: providerConfig.apiKey,
    base_url: baseUrl,
    models: modelNames.join(","),
    group: channelName,
    priority: 0,
    weight: 1,
    status: 1,
    tag,
    remark: `AI Horde image via ${providerConfig.name}`,
    workflow_templates: JSON.stringify({ models }),
    // auto_ban=0: queue timeouts + NSFW trips must not self-disable the channel.
    auto_ban: 0,
  };

  report.success = true;
  report.groups = 1;
  report.models = modelNames.length;
  return { channels: [channel], report };
}
