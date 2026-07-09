import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface LlmtrModel {
  id: string;
}

// LLMTR (llmtr.com/v1) - Turkish LLM aggregator, 198-model frontier catalog. Only one id is
// free (qwen/qwen3-32b-free); everything else hard-blocks at 402 insufficient_credits with no
// card. Filter strictly to the -free suffix. Vendor-prefixed ids (bare-name strips qwen/).
export async function discoverLlmtrModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "LLMTR", url }));

  const data = await tryFetchJson<{ data: LlmtrModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const free = (data?.data ?? []).filter((m) => m.id.endsWith("-free"));
  return { models: free.map((m) => m.id), maxOutputByModel: new Map() };
}
