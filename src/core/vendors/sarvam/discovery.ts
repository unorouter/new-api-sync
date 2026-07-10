import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface SarvamModel {
  id: string;
}

// Sarvam AI (api.sarvam.ai/v1) - India's sovereign LLM platform. Rs.100-1000 free signup credits
// (never expire, no card; PAYG after with no auto-charge). Indian-language chat models sarvam-105b
// + sarvam-30b (unique niche: Hindi/Tamil/Telugu/Bengali/... 10 Indian languages). OpenAI-compatible.
// (TTS/STT/translate/doc endpoints are non-chat, skipped - /v1/models returns only the chat models.)
export async function discoverSarvamModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Sarvam", url }));

  const data = await tryFetchJson<{ data: SarvamModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  return {
    models: (data?.data ?? []).map((m) => m.id),
    maxOutputByModel: new Map(),
  };
}
