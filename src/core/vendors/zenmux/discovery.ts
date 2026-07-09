import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ZenMuxPriceEntry {
  value?: number;
}

interface ZenMuxModel {
  id: string;
  pricings?: {
    prompt?: ZenMuxPriceEntry[];
    completion?: ZenMuxPriceEntry[];
  };
}

// ZenMux (zenmux.ai/api/v1) - PAYG aggregator, 144 models. Free tier = the handful of
// -free ids whose every prompt/completion price entry is 0 (grok-4.5-free, step-3.7-flash-free,
// glm-4.7/4.6v-flash-free). Paid ids hard-block 403/402 with $0 balance and no card, so filter
// strictly to all-zero pricing. claude-fable-5-free is excluded: balance>0 anti-abuse gate (402)
// and sunsets 2026-07-10. Base includes /api; ids carry vendor/ prefix (bare-name strips).
const BALANCE_GATED = new Set(["anthropic/claude-fable-5-free"]);

export async function discoverZenMuxModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "ZenMux", url }));

  const data = await tryFetchJson<{ data: ZenMuxModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const free = (data?.data ?? []).filter((m) => {
    if (BALANCE_GATED.has(m.id)) return false;
    const entries = [
      ...(m.pricings?.prompt ?? []),
      ...(m.pricings?.completion ?? []),
    ];
    return entries.length > 0 && entries.every((e) => e.value === 0);
  });
  return { models: free.map((m) => m.id), maxOutputByModel: new Map() };
}
