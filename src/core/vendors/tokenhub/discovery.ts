import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface TokenHubModel {
  id: string;
}

// Tencent TokenHub (tokenhub-intl.tencentcloudmaas.com/v1) - Tencent Cloud MaaS
// Singapore intl gateway. New-user free trial: 1M tokens/model + 60 QPM. 22 frontier
// models (GLM-5.x, Kimi-K2.5/2.6/2.7, DeepSeek-V4-pro/flash/V3.2, MiniMax-M2.x/M3,
// hy-mt2) + kinfra embeddings. OpenAI-compat, Bearer key from the TokenHub console.
// Reasoning models emit reasoning_content; tool-calling verified.
export async function discoverTokenHubModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "TokenHub", url }));

  const data = await tryFetchJson<TokenHubModel[] | { data: TokenHubModel[] }>(
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
