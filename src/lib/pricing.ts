import type { SyncState } from "@/lib/types";

/**
 * Build price tiers by grouping models by their adjusted ratio.
 * For each model, finds the cheapest existing group ratio from other providers,
 * then applies the adjustment to get the final ratio.
 */
export function buildPriceTiers(
  models: string[],
  adjustment: number,
  state: SyncState,
  excludeProvider: string,
): Map<number, string[]> {
  const groupRatioByName = new Map(
    state.mergedGroups.map((g) => [g.name, g.ratio]),
  );
  const cheapestGroupForModel = new Map<string, number>();
  const allChannels = state.channelsToCreate;
  for (const ch of allChannels) {
    if (ch.provider === excludeProvider) continue;
    const gRatio = groupRatioByName.get(ch.group) ?? 1;
    for (const model of ch.models) {
      const existing = cheapestGroupForModel.get(model);
      if (existing === undefined || gRatio < existing) {
        cheapestGroupForModel.set(model, gRatio);
      }
    }
  }

  const ratioToModels = new Map<number, string[]>();
  for (const model of models) {
    const cheapest = cheapestGroupForModel.get(model) ?? 1;
    const ratio = cheapest * (1 + adjustment);
    const key = Math.round(ratio * 1e6) / 1e6;
    if (!ratioToModels.has(key)) ratioToModels.set(key, []);
    ratioToModels.get(key)!.push(model);
  }
  return ratioToModels;
}

/**
 * Push tiered channels and groups into SyncState from a ratio→models map.
 */
export function pushTieredChannels(
  ratioToModels: Map<number, string[]>,
  baseName: string,
  opts: {
    type: number;
    key: string;
    baseUrl: string;
    provider: string;
    description: string;
  },
  state: SyncState,
): void {
  let tierIdx = 0;
  for (const [groupRatio, models] of ratioToModels) {
    const suffix = ratioToModels.size > 1 ? `-t${tierIdx}` : "";
    const tierName = `${baseName}${suffix}`;

    state.mergedGroups.push({
      name: tierName,
      ratio: groupRatio,
      description: opts.description,
      provider: opts.provider,
    });

    state.channelsToCreate.push({
      name: tierName,
      type: opts.type,
      key: opts.key,
      baseUrl: opts.baseUrl,
      models,
      group: tierName,
      priority: 0,
      weight: 1,
      provider: opts.provider,
      remark: tierName,
    });

    tierIdx++;
  }
}
