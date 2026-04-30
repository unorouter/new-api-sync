import type { RuntimeConfig } from "@core/config";
import type { BaselineInputs } from "@core/pricing/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import type { TargetSnapshot } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";

/**
 * Build BaselineInputs from the target snapshot. Pricing computation needs
 * these so partial-sync (--only) and sub2api's "cheapest existing group
 * ratio" lookup can see what other (non-managed) channels exist.
 *
 * Returns an empty baseline when no snapshot is provided (initial sync,
 * test mode). For partial syncs, also fetches /api/pricing on the target
 * to seed pricing-only groups + model ratios that aren't represented by
 * channels in the snapshot.
 */
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
  try {
    const raw = opts.targetSnapshot.options["GroupRatio"];
    if (raw) snapshotGroupRatio = JSON.parse(raw);
  } catch {}

  const seededGroups = new Set<string>();
  for (const ch of opts.targetSnapshot.channels) {
    if (ch.tag && opts.managedProviders.has(ch.tag)) continue;
    baseline.channels.push(ch);

    if (!seededGroups.has(ch.group)) {
      seededGroups.add(ch.group);
      const ratio =
        pricingGroupRatio.get(ch.group) ?? snapshotGroupRatio[ch.group] ?? 1;
      baseline.groups.push({
        name: ch.group,
        ratio,
        description: `baseline: ${ch.group}`,
        provider: ch.tag ?? "__baseline__",
      });
    }
  }

  // Partial sync: also add pricing-only groups and seed model ratios
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
      if (!baseline.modelRatios.has(model.name)) {
        baseline.modelRatios.set(model.name, {
          ratio: model.ratio,
          completionRatio: model.completionRatio ?? 1,
          modelPrice: model.modelPrice,
        });
      }
    }
  }

  consola.debug(
    t("CORE.PIPELINE.BASELINE_SEEDED", {
      channels: baseline.channels.length,
      groups: baseline.groups.length,
    }),
  );
  for (const g of baseline.groups) {
    consola.debug(
      t("CORE.PIPELINE.BASELINE_GROUP", {
        name: g.name,
        ratio: g.ratio.toFixed(4),
        provider: g.provider,
      }),
    );
  }

  return baseline;
}
