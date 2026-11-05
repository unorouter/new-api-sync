import {
  measureProbeCost,
  recordProbeCostLine,
  replyCostSince,
} from "@core/testing/probe-cost";
import { recordProviderCost } from "@core/testing/runner";
import type { ClientContext } from "@core/vendors/newapi/context";
import { t } from "@server/i18n";
import { consola } from "consola";
import { colorize } from "consola/utils";

export function logProbeCost(
  providerName: string,
  source: string,
  probe: { cost: number; billed: number },
): void {
  recordProviderCost(providerName, probe.cost);
  recordProbeCostLine(providerName, source, probe);
  consola.info(
    t("CORE.PROVIDER.PROBE_COST_ONLY", {
      name: providerName,
      cost: colorize("yellow", `$${probe.cost.toFixed(4)}`),
      billed: probe.billed,
    }),
  );
}

/** Marketplaces price every reply; sums what this run's probes were billed. */
export function recordReplyCostRun(
  providerName: string,
  baseUrl: string,
  since: number,
): void {
  logProbeCost(
    providerName,
    "reply",
    replyCostSince(new URL(baseUrl).host, since),
  );
}

/** Relays log every request; sums the rows our probe ids were billed on. */
export async function recordRelayProbeCostRun(
  providerName: string,
  source: string,
  ctx: ClientContext,
  since: number,
): Promise<void> {
  const probe = await measureProbeCost(ctx, since);
  if (probe) logProbeCost(providerName, source, probe);
  else
    consola.warn(
      t("CORE.PROVIDER.PROBE_COST_UNAVAILABLE", { name: providerName }),
    );
}

/** Start/end balance bracket. null → skip silently. body errors propagate. */
export async function withCostTracking<T>(
  providerName: string,
  fetchBalance: () => Promise<number | null>,
  body: () => Promise<T>,
): Promise<T> {
  const startBalance = await fetchBalance();
  if (startBalance !== null) {
    consola.info(
      t("CORE.PROVIDER.BALANCE", {
        name: providerName,
        amount: startBalance.toFixed(4),
      }),
    );
  }

  let result: T;
  let bodyError: unknown;
  try {
    result = await body();
  } catch (e) {
    bodyError = e;
  }

  if (startBalance !== null) {
    const finalBalance = await fetchBalance();
    if (finalBalance !== null) {
      const cost = startBalance - finalBalance;
      recordProviderCost(providerName, cost);
      consola.info(
        cost > 0
          ? t("CORE.PROVIDER.BALANCE_WITH_COST", {
              name: providerName,
              amount: finalBalance.toFixed(4),
              cost: `$${cost.toFixed(4)}`,
            })
          : t("CORE.PROVIDER.BALANCE", {
              name: providerName,
              amount: finalBalance.toFixed(4),
            }),
      );
    }
  }

  if (bodyError !== undefined) throw bodyError;
  return result!;
}
