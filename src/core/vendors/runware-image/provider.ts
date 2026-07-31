// No remote catalog; one channel per runware block, model list from config.
// Bypasses pricing/emit; synthesizes Channel directly (mirrors aihorde-image/provider.ts).
// Runware addresses models by AIR, so the published id reaches the upstream through
// model_mapping rather than a params blob.

import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import type { Channel, ProviderReport } from "@core/types";
import type { RunwareProviderConfig } from "@core/validations/config";

export function buildRunwareChannels(providerConfig: RunwareProviderConfig): {
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
    report.error = "runware: no models defined";
    return { channels: [], report };
  }

  const baseUrl = (providerConfig.baseUrl ?? "https://api.runware.ai").replace(
    /\/$/,
    "",
  );
  const channelName =
    providerConfig.channelName ?? sanitizeGroupName(providerConfig.name);
  const tag = providerConfig.channelTag ?? providerConfig.name;

  const modelMapping: Record<string, string> = {};
  for (const [name, m] of Object.entries(providerConfig.models)) {
    modelMapping[name] = m.air;
  }

  const channel: Channel = {
    name: channelName,
    type: CHANNEL_TYPES.RUNWARE,
    key: providerConfig.apiKey,
    base_url: baseUrl,
    models: modelNames.join(","),
    model_mapping: JSON.stringify(modelMapping),
    group: channelName,
    priority: 0,
    weight: 1,
    status: 1,
    tag,
    remark: `Runware image via ${providerConfig.name}`,
  };

  report.success = true;
  report.groups = 1;
  report.models = modelNames.length;
  return { channels: [channel], report };
}
