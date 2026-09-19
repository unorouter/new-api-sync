import { getConcurrencyGate } from "@core/infra/concurrency";
import { tryFetchJson } from "@core/infra/http";
import type { RuntimeConfig } from "@core/config";
import type { AnyProviderConfig } from "@core/validations/config";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";

export interface BalanceEntry {
  name: string;
  type: string;
  balance: number | null;
  error?: string;
}

export interface BalanceResult {
  target: BalanceEntry;
  providers: BalanceEntry[];
  total: number;
  unavailable: number;
}

async function fetchOpenRouterBalance(
  baseUrl: string,
  apiKey: string,
): Promise<number | null> {
  const data = await tryFetchJson<{
    data?: { total_credits?: number; total_usage?: number };
  }>(`${baseUrl.replace(/\/$/, "")}/v1/credits`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const credits = data?.data?.total_credits;
  const usage = data?.data?.total_usage;
  return credits === undefined || usage === undefined ? null : credits - usage;
}

// DeepInfra bills through Stripe: stripe_balance is a Stripe customer balance, so it
// is NEGATIVE when funds are available and positive when money is owed. `recent` is
// usage accrued since the last invoice, not yet billed, so spendable credit is
// -stripe_balance - recent. The route is absent from the prose docs but declared
// Bearer-auth in the live OpenAPI spec, and /v1/me returns it inline with ?checklist=true.
async function fetchDeepInfraBalance(
  baseUrl: string,
  apiKey: string,
): Promise<number | null> {
  const data = await tryFetchJson<{
    checklist?: { stripe_balance?: number; recent?: number };
  }>(`${baseUrl.replace(/\/$/, "")}/v1/me?checklist=true`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const checklist = data?.checklist;
  if (typeof checklist?.stripe_balance !== "number") return null;
  return -checklist.stripe_balance - (checklist.recent ?? 0);
}

// The relay's account lives on its site (the catalog's origin), not the API
// host; the consumer balance is a decimal dollar string.
async function fetchPoolRelayBalance(
  catalogUrl: string,
  apiKey: string,
): Promise<number | null> {
  const data = await tryFetchJson<{
    balances?: { consumer_balance?: string | number };
  }>(`${new URL(catalogUrl).origin}/api/me`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const raw = data?.balances?.consumer_balance;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The order book bills in whole micro-USDC; spendable funds are the available
// on-chain and fiat balances (held and pending amounts are not).
async function fetchOrderBookBalance(
  baseUrl: string,
  apiKey: string,
): Promise<number | null> {
  const data = await tryFetchJson<{
    usdc_available_usdc?: string | number;
    fiat_available_usdc?: string | number;
  }>(`${baseUrl.replace(/\/$/, "")}/v1/payments/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const micro = (v: string | number | undefined) =>
    typeof v === "string" ? Number(v) : (v ?? Number.NaN);
  const usdc = micro(data?.usdc_available_usdc);
  const fiat = micro(data?.fiat_available_usdc);
  if (!Number.isFinite(usdc)) return null;
  return (usdc + (Number.isFinite(fiat) ? fiat : 0)) / 1e6;
}

async function providerBalance(
  provider: AnyProviderConfig,
): Promise<BalanceEntry> {
  const entry: BalanceEntry = {
    name: provider.name,
    type: provider.type,
    balance: null,
  };
  try {
    switch (provider.type) {
      // a7 is a new-api fork; same /api/user/self quota endpoint and auth.
      case "a7":
      case "newapi": {
        entry.balance = await new NewApiClient(
          provider,
          provider.name,
        ).fetchBalance();
        break;
      }
      case "openrouter": {
        // /v1/credits answers 403 "Only management keys can fetch credits for an
        // account" to an inference key, so a provider that has a management key
        // must read its balance with that one or report none at all.
        entry.balance = await fetchOpenRouterBalance(
          provider.baseUrl ?? "https://openrouter.ai/api",
          provider.managementKey ?? provider.apiKey ?? "",
        );
        break;
      }
      case "deepinfra": {
        entry.balance = await fetchDeepInfraBalance(
          provider.baseUrl ?? "https://api.deepinfra.com",
          provider.apiKey,
        );
        break;
      }
      case "ih": {
        entry.balance = await fetchPoolRelayBalance(
          provider.catalogUrl,
          provider.apiKey,
        );
        break;
      }
      case "si": {
        entry.balance = await fetchOrderBookBalance(
          provider.baseUrl,
          provider.apiKey,
        );
        break;
      }
      default:
        // Keyless/free and fixed-cost providers expose no balance endpoint.
        break;
    }
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  return entry;
}

export async function checkBalances(
  config: RuntimeConfig,
): Promise<BalanceResult> {
  const gate = getConcurrencyGate();
  const target: BalanceEntry = {
    name: t("CLI.BALANCE.TARGET"),
    type: "newapi",
    balance: null,
  };
  try {
    target.balance = await new NewApiClient(
      config.target,
      "target",
    ).fetchBalance();
  } catch (error) {
    target.error = error instanceof Error ? error.message : String(error);
  }

  const providers = await Promise.all(
    config.providers.map((p) => gate.run(p.name, () => providerBalance(p))),
  );

  let total = 0;
  let unavailable = 0;
  for (const entry of providers) {
    if (entry.balance === null) unavailable++;
    else total += entry.balance;
  }
  return { target, providers, total, unavailable };
}

const money = (value: number) => `$${value.toFixed(4)}`;

export function printBalanceSummary(result: BalanceResult): void {
  const line = (entry: BalanceEntry) =>
    entry.error !== undefined
      ? t("CLI.BALANCE.ROW_ERROR", {
          name: entry.name,
          type: entry.type,
          error: entry.error,
        })
      : entry.balance === null
        ? t("CLI.BALANCE.ROW_NONE", { name: entry.name, type: entry.type })
        : t("CLI.BALANCE.ROW", {
            name: entry.name,
            type: entry.type,
            amount: money(entry.balance),
          });

  consola.info(t("CLI.BALANCE.HEADER"));
  consola.info(line(result.target));

  const withBalance = result.providers.filter((p) => p.balance !== null);
  const without = result.providers.filter((p) => p.balance === null);
  withBalance.sort((a, b) => b.balance! - a.balance!);

  for (const entry of withBalance) consola.info(line(entry));
  for (const entry of without)
    if (entry.error !== undefined) consola.warn(line(entry));

  consola.info(
    t("CLI.BALANCE.TOTAL", {
      amount: money(result.total),
      counted: withBalance.length,
      skipped: result.unavailable,
    }),
  );
}
