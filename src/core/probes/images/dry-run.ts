import type { ProviderConfig } from "@core/validations/config";
import { redactUrl } from "@core/testing/redact";
import type { DiscoveryReport } from "./pipeline/candidates";
import { compareGroupChannels, type GroupChannel } from "./group-map";
import type { DryRunCandidate, DryRunProvider } from "./io/store";

export function buildDryRunProvider(opts: {
  provider: ProviderConfig;
  totalModels: number;
  totalChannels: number;
  discovery: DiscoveryReport;
  groupMap: Map<string, GroupChannel[]>;
}): DryRunProvider {
  const { provider, totalModels, totalChannels, discovery, groupMap } = opts;
  const candidates: DryRunCandidate[] = discovery.candidates.map((c) => {
    const chs = (groupMap.get(c.modelName) ?? [])
      .slice()
      .sort(compareGroupChannels);
    return {
      model: c.modelName,
      canonicalKey: c.canonicalKey,
      aliases: c.aliases,
      kind: c.kind,
      endpointTypes: c.endpointTypes,
      tags: c.tags,
      vendorId: c.vendorId,
      channels: chs.map((g) => ({
        id: 0,
        name: g.groupName,
        priority: 0,
        weight: 0,
      })),
      reasons: c.reasons,
    };
  });
  return {
    name: provider.name,
    baseUrl: redactUrl(provider.baseUrl),
    totalModels,
    totalChannels,
    candidates,
    excluded: discovery.excluded.map((e) => ({
      model: e.modelName,
      reason: e.reason,
    })),
  };
}

/** Re-fetch raw /api/pricing to recover V2 model_info.tags that parsePricing discards. */
export async function tryFetchLegacyModelInfo(
  provider: ProviderConfig,
): Promise<
  | Record<string, { supplier?: string; tags?: string[]; illustrate?: string }>
  | undefined
> {
  const url = provider.baseUrl.replace(/\/$/, "") + "/api/pricing";
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${provider.systemAccessToken}`,
        "New-Api-User": String(provider.userId),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return undefined;
    const json = (await r.json()) as {
      data?: {
        model_info?: Record<
          string,
          { supplier?: string; tags?: string[]; illustrate?: string }
        >;
      };
    };
    return json?.data?.model_info;
  } catch {
    return undefined;
  }
}
