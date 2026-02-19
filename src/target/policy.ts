import type { PolicyState } from "@/core/types";
import type { Channel } from "@/lib/types";

const RESPONSES_COMPATIBLE_CHANNEL_TYPES = new Set([1, 17, 39, 27, 45, 57, 48]);
const RESPONSES_ENDPOINTS = new Set(["openai-response", "openai-response-compact"]);

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildResponsesPolicy(
  channels: Channel[],
  modelEndpoints: Map<string, string[]>,
): PolicyState {
  const channelTypes = [...new Set(
    channels
      .map((channel) => channel.type)
      .filter((type) => RESPONSES_COMPATIBLE_CHANNEL_TYPES.has(type)),
  )].sort((a, b) => a - b);

  const models = new Set<string>();
  for (const channel of channels) {
    if (!RESPONSES_COMPATIBLE_CHANNEL_TYPES.has(channel.type)) continue;
    const channelModels = channel.models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    for (const model of channelModels) {
      const endpoints = modelEndpoints.get(model);
      if (!endpoints || endpoints.length === 0) {
        models.add(model);
        continue;
      }
      if (endpoints.some((endpoint) => RESPONSES_ENDPOINTS.has(endpoint))) {
        models.add(model);
      }
    }
  }

  const modelPatterns = [...models]
    .sort((a, b) => a.localeCompare(b))
    .map((model) => `^${escapeRegExp(model)}$`);

  const enabled = channelTypes.length > 0 && modelPatterns.length > 0;

  return {
    enabled,
    all_channels: false,
    channel_types: channelTypes,
    model_patterns: modelPatterns,
  };
}
