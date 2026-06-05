import type { RuntimeConfig } from "@core/config";
import type { BaselineInputs } from "@core/pricing/types";
import type { TargetSnapshot } from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { consola } from "consola";

export async function buildBaseline(opts: {
  config: RuntimeConfig;
  targetSnapshot?: TargetSnapshot;
  managedProviders: Set<string>;
}): Promise<BaselineInputs> {
  const baseline: BaselineInputs = {
    groups: [],
    channels: [],
    modelRatios: new Map(),
  };

  if (!opts.targetSnapshot) return baseline;

  let pricingGroupRatio = new Map<string, number>();
  let snapshotGroupRatio: Record<string, number> = {};
  let targetPricing:
    | Awaited<ReturnType<NewApiClient["fetchPricing"]>>
    | undefined;

  if (opts.config.onlyProviders) {
    const targetClient = new NewApiClient(opts.config.target, "target");
    targetPricing = await targetClient.fetchPricing();
    pricingGroupRatio = new Map(
      targetPricing.groups.map((g) => [g.name, g.ratio]),
    );
  }
  const rawGroupRatio = opts.targetSnapshot.options["GroupRatio"];
  if (rawGroupRatio) {
    try {
      snapshotGroupRatio = JSON.parse(rawGroupRatio);
    } catch (err) {
      // Partial sync needs these ratios to preserve out-of-scope groups; {} would reset them to 1.
      const detail = err instanceof Error ? err.message : String(err);
      const isPartialSync =
        !!opts.config.onlyProviders ||
        (opts.config.modelFilter?.length ?? 0) > 0;
      if (isPartialSync)
        throw new Error(
          `Refusing partial sync: target GroupRatio is corrupted (${detail}).`,
        );
      consola.warn(
        `Target GroupRatio failed to parse (${detail}); treating as empty.`,
      );
    }
  }

  const seededGroups = new Set<string>();
  for (const ch of opts.targetSnapshot.channels) {
    if (ch.tag && opts.managedProviders.has(ch.tag)) continue;
    baseline.channels.push(ch);
    if (seededGroups.has(ch.group)) continue;
    seededGroups.add(ch.group);
    baseline.groups.push({
      name: ch.group,
      ratio:
        pricingGroupRatio.get(ch.group) ?? snapshotGroupRatio[ch.group] ?? 1,
      description: `baseline: ${ch.group}`,
      provider: ch.tag ?? "__baseline__",
    });
  }

  if (targetPricing) {
    for (const group of targetPricing.groups) {
      if (seededGroups.has(group.name)) continue;
      baseline.groups.push({
        name: group.name,
        ratio: group.ratio,
        description: group.description,
        provider: "__baseline__",
      });
    }
    for (const model of targetPricing.models) {
      if (baseline.modelRatios.has(model.name)) continue;
      baseline.modelRatios.set(model.name, {
        ratio: model.ratio,
        completionRatio: model.completionRatio ?? 1,
        modelPrice: model.modelPrice,
      });
    }
  }

  return baseline;
}
