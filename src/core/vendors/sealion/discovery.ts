import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface SeaLionModel {
  id: string;
}

// SEA-LION (api.sea-lion.ai/v1, AI Singapore). LiteLLM proxy, OpenAI-shaped. Free
// Google-SSO key, 10 rpm/user, no card. Base is the host; runner + discovery append /v1.
// Direct lane (vs the qwen-sea-lion we already serve via publicai) adds Apertus-SEA-LION
// + a SEA embedding model. LICENSE TRAP: Gemma-SEA-LION (Gemma Terms) and Llama-SEA-LION
// (Llama 3 Community License) carry commercial restrictions -> EXCLUDED for our commercial
// gateway. SEA-Guard is a safety classifier (not chat/embedding) -> excluded. Keep only the
// Apache-2.0 subset (Qwen-SEA-LION, Apertus-SEA-LION, ModernBERT-Embedding).
const LICENSE_BLOCKED = /gemma-sea-lion|llama-sea-lion|sea-guard/i;

export async function discoverSeaLionModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "SEA-LION", url }));

  const data = await tryFetchJson<{ data?: SeaLionModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = (data?.data ?? [])
    .map((m) => m.id)
    .filter((id) => id && !LICENSE_BLOCKED.test(id));
  return { models: list, maxOutputByModel: new Map() };
}
