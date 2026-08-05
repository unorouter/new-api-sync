import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface QwenModel {
  id: string;
}
interface QwenModelList {
  data: QwenModel[];
}

// chat.qwen.ai reverse via OpenGate. The listing reflects what the pooled
// accounts are entitled to, so it is the accurate catalog - a free account sees
// the full 18-model list including qwen3.8-max, coder-plus and the omni models.
export async function discoverQwenModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Qwen", url }));

  const data = await tryFetchJson<QwenModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 20_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (m.id) models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
