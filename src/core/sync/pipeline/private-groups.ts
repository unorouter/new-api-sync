import type { Channel, MergedGroup } from "@core/types";
import type { PrivateProviderConfig } from "@core/validations/config";

interface PrivateGroupsResult {
  channels: Channel[];
  mergedGroups: MergedGroup[];
  // identityGroup -> { "+:routingGroup": desc }, the group_special_usable_group grant.
  groupSpecialUsableGroup: Record<string, Record<string, string>>;
}

// Build private channels + routing groups + the per-identity grant from every
// `type: private` provider. Routing groups are flagged `private` so buildOptionMaps
// keeps them out of the global UserUsableGroups while still registering GroupRatio.
export function buildPrivateGroups(
  providers: PrivateProviderConfig[],
): PrivateGroupsResult {
  const channels: Channel[] = [];
  const mergedGroups: MergedGroup[] = [];
  const groupSpecialUsableGroup: Record<string, Record<string, string>> = {};

  for (const pg of providers) {
    const grants: Record<string, string> =
      groupSpecialUsableGroup[pg.identity] ?? {};
    // The identity group itself must exist in GroupRatio (it is the user's
    // account group); register it, kept private so it is not globally usable.
    mergedGroups.push({
      name: pg.identity,
      ratio: pg.ratio ?? 1,
      description: pg.identity,
      provider: pg.name,
      private: true,
    });

    for (const ch of pg.channels) {
      const desc = ch.desc ?? ch.group;
      grants[`+:${ch.group}`] = desc;
      mergedGroups.push({
        name: ch.group,
        ratio: ch.ratio ?? 0,
        description: desc,
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

    groupSpecialUsableGroup[pg.identity] = grants;
  }

  return { channels, mergedGroups, groupSpecialUsableGroup };
}
