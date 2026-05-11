import { recordProviderCost } from "@core/testing/runner";
import { t } from "@server/i18n";
import { consola } from "consola";

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
