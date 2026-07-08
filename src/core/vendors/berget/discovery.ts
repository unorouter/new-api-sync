import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface BergetModel {
  id: string;
}

// Berget.AI (api.berget.ai/v1) - EU/GDPR-hosted (Sweden) inference. 14 models: GLM-5.2/4.7,
// Kimi-K2.6, Mistral-Medium/Small, gpt-oss-120b, Llama-3.3-70B (chat) + whisper (audio) +
// e5/bge (embeddings). Vendor-namespaced ids (bare-name strips). Free 5EUR trial, hard-stops
// at 0 with no card (auto-top-up disabled on trial). OpenAI-compat, tool-calling verified.
export async function discoverBergetModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Berget.AI", url }));

  const data = await tryFetchJson<BergetModel[] | { data: BergetModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
