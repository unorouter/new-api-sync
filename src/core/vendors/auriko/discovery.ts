import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AurikoModel {
  id: string;
}

// Auriko (api.auriko.ai/v1) - multi-vendor relay, 177 models across every family
// (Claude/GPT/Gemini/Grok/Qwen/GLM/DeepSeek/Kimi/...). $0.99 trial + 14-day Pro,
// hard-stops at $0 with no card. Standard OpenAI-compat. Authenticity probes drop any
// faked closed-model channels (relay fake-Claude risk).
export async function discoverAurikoModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Auriko", url }));

  const data = await tryFetchJson<AurikoModel[] | { data: AurikoModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
