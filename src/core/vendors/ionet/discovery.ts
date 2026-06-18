import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface IoNetModel {
  id: string;
}

// io.net (api.intelligence.io.solutions/api/v1) - decentralized GPU inference, free
// tier. ~29 frontier models (DeepSeek-V4, Kimi-K2.x, GLM-4.x/5.x, MiniMax, Qwen3.x,
// Llama-4, gpt-oss). Standard OpenAI /models shape. Dynamic; probe drops any that fail.
// Note: io.net API keys expire after ~180 days (not permanent) - rotate periodically.
export async function discoverIoNetModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "io.net", url }));

  const data = await tryFetchJson<IoNetModel[] | { data: IoNetModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
