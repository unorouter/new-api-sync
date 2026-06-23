import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AkashMlModel {
  id: string;
}

// AkashML (api.akashml.com/v1) - Akash Network decentralized GPU inference. $100 signup
// credit then PAYG. Wired as a failover backend: 6 models that overlap io.net (DeepSeek-V4-Flash,
// Kimi-K2.7-Code, Qwen3.5/3.6-35B, Llama-3.3-70B, MiniMax-M2.5). Standard OpenAI /models shape.
// Dynamic; probe drops any that fail.
export async function discoverAkashMlModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "AkashML", url }));

  const data = await tryFetchJson<AkashMlModel[] | { data: AkashMlModel[] }>(
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
