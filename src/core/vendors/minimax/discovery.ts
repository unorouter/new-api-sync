import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface MiniMaxModel {
  id: string;
}

// MiniMax international (api.minimax.io/v1) - direct vendor (distinct from Zhipu/DeepSeek).
// OpenAI-compat. Trial credits on signup (email/phone, no card). Frontier M2.x/M3, 1M context.
// /v1/models needs the key. Dynamic; probe drops any that fail. If the catalog list isn't
// served, this returns empty and the curated fallback in config (modelMapping/paidModels) applies.
export async function discoverMiniMaxModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "MiniMax", url }));

  const data = await tryFetchJson<MiniMaxModel[] | { data: MiniMaxModel[] }>(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 15_000,
    },
  );

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
