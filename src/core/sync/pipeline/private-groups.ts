import type { Channel, MergedGroup } from "@core/types";
import type { PrivateProviderConfig } from "@core/validations/config";

interface PrivateGroupsResult {
  channels: Channel[];
  mergedGroups: MergedGroup[];
}

// Build private channels + routing groups from every `type: private` provider.
// Routing groups are flagged `private` so buildOptionMaps registers their
// GroupRatio (needed for routing + the /self/groups intersection) while keeping
// them OUT of the global UserUsableGroups. Granting access is done per-user in
// the new-api admin UI (users.setting.usable_groups), not here.
export function buildPrivateGroups(
  providers: PrivateProviderConfig[],
): PrivateGroupsResult {
  const channels: Channel[] = [];
  const mergedGroups: MergedGroup[] = [];

  for (const pg of providers) {
    for (const ch of pg.channels) {
      mergedGroups.push({
        name: ch.group,
        ratio: ch.ratio ?? 0,
        description: ch.desc ?? ch.group,
        provider: pg.name,
        private: true,
      });
      channels.push({
        name: ch.channelName ?? ch.group,
        type: ch.type,
        key: ch.apiKey,
        base_url: ch.baseUrl,
        models: ch.models.join(","),
        group: ch.group,
        priority: 0,
        weight: 1,
        status: 1,
        tag: pg.name,
        model_mapping:
          ch.modelMapping && Object.keys(ch.modelMapping).length > 0
            ? JSON.stringify(ch.modelMapping)
            : undefined,
        param_override: ch.paramOverride,
      });
    }
  }

  return { channels, mergedGroups };
}
