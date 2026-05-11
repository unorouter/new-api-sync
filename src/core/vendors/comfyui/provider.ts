// No remote catalog; one channel per comfyui block, model list from config templates.
// Bypasses pricing/emit; synthesizes Channel directly.

import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import type { Channel, ProviderReport } from "@core/types";
import type { ComfyUiProviderConfig } from "@core/validations/config";

export function buildComfyUiChannels(providerConfig: ComfyUiProviderConfig): {
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

  const provider = providerConfig.provider;
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");

  const modelNames = Object.keys(providerConfig.templates);
  if (modelNames.length === 0) {
    report.error = "comfyui: no templates defined";
    return { channels: [], report };
  }

  const channelName =
    providerConfig.channelName ?? sanitizeGroupName(providerConfig.name);
  const tag = providerConfig.channelTag ?? providerConfig.name;

  // Adapter expects {provider, app, templates}; app is the endpoint id (RunPod / fal slug).
  const workflowTemplates = JSON.stringify({
    provider,
    app: providerConfig.app ?? "",
    templates: providerConfig.templates,
  });

  const channel: Channel = {
    name: channelName,
    type: CHANNEL_TYPES.COMFYUI,
    key: providerConfig.apiKey,
    base_url: baseUrl,
    models: modelNames.join(","),
    group: channelName,
    priority: 0,
    weight: 1,
    status: 1,
    tag,
    remark: `ComfyUI (${provider}) via ${providerConfig.name}`,
    workflow_templates: workflowTemplates,
    // auto_ban=0: image/task channels stay enabled (cold starts + NSFW trips otherwise self-disable).
    auto_ban: 0,
  };

  report.success = true;
  report.groups = 1;
  report.models = modelNames.length;
  return { channels: [channel], report };
}
