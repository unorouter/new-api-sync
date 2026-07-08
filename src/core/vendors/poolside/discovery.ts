import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface PoolsideModel {
  id: string;
}

// Poolside (inference.poolside.ai/v1) - first-party coding/reasoning models
// (laguna-m.1, laguna-xs.2, laguna-xs-2.1). laguna-m.1 is a reasoning model:
// content lands in reasoning_content then the final message, so probes need a
// generous output budget or they finish_reason=length. OpenAI-compat, key-gated
// free tier. Tool-calling + streaming verified.
export async function discoverPoolsideModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Poolside", url }));

  const data = await tryFetchJson<PoolsideModel[] | { data: PoolsideModel[] }>(
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
