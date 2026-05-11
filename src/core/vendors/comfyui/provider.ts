// ComfyUI provider — emits one channel per `comfyui` block in config.
//
// Unlike the upstream-discovery providers (newapi, openrouter, nvidia,
// sub2api), ComfyUI has no remote catalog: the model list comes from
// hand-authored workflow templates in config.yml. We bypass the pricing /
// emit pipeline entirely and synthesize the Channel object directly.

import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import type { Channel, ProviderReport } from "@core/types";
import type { ComfyUiProviderConfig } from "@core/validations/config";

export function buildComfyUiChannels(
  providerConfig: ComfyUiProviderConfig,
): { channels: Channel[]; report: ProviderReport } {
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

  // The new-api adapter expects `provider`, `app`, and `templates` siblings on the
  // workflow_templates JSON object. `app` is the provider-specific endpoint id
  // (RunPod serverless endpoint id, fal app slug, etc.) — the adapter reads it
  // when building the upstream submit URL.
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
    // RunPod cold starts and one-off NSFW filter trips look like upstream
    // failures to new-api. Without auto_ban=0, the channel keeps disabling
    // itself and we have to manually re-enable it. Stay-enabled-on-failure
    // is the right policy for image/task channels (failures are logged
    // either way).
    auto_ban: 0,
  };

  report.success = true;
  report.groups = 1;
  report.models = modelNames.length;
  return { channels: [channel], report };
}
