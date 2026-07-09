import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface RegoloModel {
  id: string;
}

// Regolo.ai (api.regolo.ai/v1) - EU/green LLM API, 30-day free trial: 1M tok/day, all Core
// Models, NO card. After 30d -> PAYG (no auto-charge without adding a card). ~18 models incl
// glm-5.2 (as glm5.2-beta), gpt-oss-120b/20b, qwen3.5-122b, apertus-70b (Swiss AI), mistral-
// small-4, gemma4-31b. Chat text only here; embedding/rerank/whisper/image skipped (different
// probe shapes, all dups). OpenAI-compatible.
const SKIP = /whisper|embedding|reranker|Qwen-Image|deepseek-ocr/i;

export async function discoverRegoloModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Regolo", url }));

  const data = await tryFetchJson<{ data: RegoloModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const chat = (data?.data ?? []).filter((m) => !SKIP.test(m.id));
  return { models: chat.map((m) => m.id), maxOutputByModel: new Map() };
}
