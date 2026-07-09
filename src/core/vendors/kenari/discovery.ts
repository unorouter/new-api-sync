import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface KenariModel {
  id: string;
  pricing?: { free?: boolean };
}

// Kenari (kenari.id/v1) - Indonesian multi-provider aggregator, pay-per-token in IDR via QRIS.
// 26-model catalog (OpenAI/Anthropic/DeepSeek/Tencent), but only 2 carry pricing.free:true
// (deepseek-v4-flash:free, hy3:free). Paid ids hard-block at 402 insufficient_balance with no
// card, so filter strictly to pricing.free. Ids already carry the :free suffix (bare-name strips).
export async function discoverKenariModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Kenari", url }));

  const data = await tryFetchJson<{ data: KenariModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const free = (data?.data ?? []).filter((m) => m.pricing?.free === true);
  return { models: free.map((m) => m.id), maxOutputByModel: new Map() };
}
