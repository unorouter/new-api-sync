import { getConcurrencyGate } from "@core/infra/concurrency";
import { tryFetchJson } from "@core/infra/http";
import type { RuntimeConfig } from "@core/config";
import type { AnyProviderConfig } from "@core/validations/config";
import { NewApiClient } from "@core/vendors/newapi/client";
import { Sub2ApiClient } from "@core/vendors/sub2api/client";
import { t } from "@server/i18n";
import { consola } from "consola";

export interface BalanceEntry {
  name: string;
  type: string;
  balance: number | null;
  error?: string;
  /** sub2api aggregates one balance per group key. */
  parts?: { name: string; balance: number | null }[];
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

/** Group keys without model discovery: balance needs the key, not the catalogue. */
async function sub2apiGroupKeys(
  client: Sub2ApiClient,
  provider: Extract<AnyProviderConfig, { type: "sub2api" }>,
): Promise<{ name: string; apiKey: string }[]> {
  if (!provider.adminApiKey)
    return (provider.groups ?? []).map((g) => ({
      name: g.name ?? g.platform,
      apiKey: g.key,
    }));

  const groups = (await client.listGroups()).filter(
    (g) => g.status === "active",
  );
  const resolved: { name: string; apiKey: string }[] = [];
  for (const group of groups) {
    const apiKey = await client.getGroupApiKey(group.id);
    if (apiKey) resolved.push({ name: group.name, apiKey });
  }
  return resolved;
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
      // a7api is a new-api fork; same /api/user/self quota endpoint and auth.
      case "a7api":
      case "newapi": {
        entry.balance = await new NewApiClient(
          provider,
          provider.name,
        ).fetchBalance();
        break;
      }
      case "openrouter": {
        entry.balance = await fetchOpenRouterBalance(
          provider.baseUrl ?? "https://openrouter.ai/api",
          provider.apiKey,
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
      case "sub2api": {
        const client = new Sub2ApiClient(provider);
        const keys = await sub2apiGroupKeys(client, provider);
        const parts = await Promise.all(
          keys.map(async (k) => ({
            name: k.name,
            balance: await client.fetchBalance(k.apiKey),
          })),
        );
        entry.parts = parts;
        entry.balance = parts.reduce<number | null>(
          (acc, p) => (p.balance === null ? acc : (acc ?? 0) + p.balance),
          null,
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

  for (const entry of withBalance) {
    consola.info(line(entry));
    for (const part of entry.parts ?? [])
      if (part.balance !== null)
        consola.info(
          t("CLI.BALANCE.PART", {
            name: part.name,
            amount: money(part.balance),
          }),
        );
  }
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
