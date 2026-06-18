import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface InfercomModel {
  id: string;
}

// Infercom (api.infercom.ai/v1) - EU/Germany-hosted, GDPR, zero-retention. OpenAI + Anthropic
// compat. EUR5 signup credit (no card), then PAYG. 9 models: DeepSeek-V3.1/V3.2, Llama-3.3-70B,
// MiniMax-M2.5/M2.7, gemma-4-31b, gpt-oss-120b + Whisper-v3 (audio), E5-Mistral (embedding).
// Catalog public; chat key-gated. Dynamic; probe drops any that fail / exhaust credit.
export async function discoverInfercomModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Infercom", url }));

  const data = await tryFetchJson<InfercomModel[] | { data: InfercomModel[] }>(
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
