import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CrowModel {
  id: string;
}

// CrowLLM (crowllm.com/v1) NewAPI gateway. $2 one-time signup credit, NO online topup
// (so zero charge risk - dies when the credit is spent). Per-request priced upstreams;
// model ids are honest (the response model field matches the request). Standard
// OpenAI /v1/models shape. ~31 models incl ernie-5.1 (Baidu) + grok-4.x + deepseek.
export async function discoverCrowLlmModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "CrowLLM", url }));

  const data = await tryFetchJson<CrowModel[] | { data: CrowModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
