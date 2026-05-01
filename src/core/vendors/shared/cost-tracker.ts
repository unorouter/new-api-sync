import { recordProviderCost } from "@core/testing/runner";
import { t } from "@server/i18n";
import { consola } from "consola";

/**
 * Wrap a provider's main work with start/end balance tracking.
 *
 * Used by the openrouter provider where the pattern is "fetch start, run
 * body, fetch end, compute cost." The newapi provider has a similar shape
 * but emits a colorized cost string and runs the end fetch inside its
 * try-block, so it stays inline. The sub2api provider sums across multiple
 * group keys and tracks balance per-key, so it stays inline too.
 *
 * `fetchBalance` returning `null` means "balance unavailable" — pricing math
 * is skipped silently, matching the pre-refactor behaviour at every call
 * site. Errors thrown from `body` propagate; the end-balance log only runs
 * on the success path.
 */
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
