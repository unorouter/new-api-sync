// No remote catalog; one channel per typesafe block, model list from config.
// Bypasses pricing/emit; synthesizes Channel directly (mirrors runware-image/provider.ts).
// Jev answers only the native decisions protocol (POST /v1/decisions), never chat, so the
// channel carries the gateway's TypeSafe type and the upstream decisions path in its setting.

import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import type { Channel, ProviderReport } from "@core/types";
import type { TypeSafeProviderConfig } from "@core/validations/config";

export const TYPESAFE_DEFAULT_BASE_URL = "https://openrouter.ai";
export const TYPESAFE_DEFAULT_DECISIONS_PATH = "/api/alpha/decisions";

export function buildTypeSafeChannels(providerConfig: TypeSafeProviderConfig): {
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
    report.error = "typesafe: no models defined";
    return { channels: [], report };
  }

  const baseUrl = (providerConfig.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const channelName =
    providerConfig.channelName ?? sanitizeGroupName(providerConfig.name);
  const tag = providerConfig.channelTag ?? providerConfig.name;

  const modelMapping: Record<string, string> = {};
  for (const [name, m] of Object.entries(providerConfig.models)) {
    if (m.upstream && m.upstream !== name) modelMapping[name] = m.upstream;
  }

  const channel: Channel = {
    name: channelName,
    type: CHANNEL_TYPES.TYPESAFE,
    key: providerConfig.apiKey,
    base_url: baseUrl,
    models: modelNames.join(","),
    model_mapping:
      Object.keys(modelMapping).length > 0
        ? JSON.stringify(modelMapping)
        : undefined,
    setting: JSON.stringify({
      decisions_upstream_path:
        providerConfig.decisionsPath ?? TYPESAFE_DEFAULT_DECISIONS_PATH,
    }),
    group: channelName,
    priority: 0,
    weight: 1,
    status: 1,
    tag,
    remark: `TypeSafe decisions via ${providerConfig.name}`,
  };

  report.success = true;
  report.groups = 1;
  report.models = modelNames.length;
  return { channels: [channel], report };
}
