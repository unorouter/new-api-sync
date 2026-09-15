import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface SeekaiModel {
  id: string;
}

// seekai.cc - new-api relay, $200 promotional balance on signup and nothing of ours
// spent, so every model publishes free. 18 models on the default group, flagship-shaped
// (gpt-5.6-sol/luna, kimi-k3, glm-5.3, gemini-3.8-flash, deepseek-v4.1-flash, MiniMax-M3).
// The catalog carries case and separator twins of the same model (DeepSeek-V4-Flash vs
// deepseek-v4-flash, glm5.3-flash vs glm-5.3-flash); the normalizer collapses them, so the
// config allowlist keeps one spelling each. Concurrency is capped hard upstream
// (您已达到并发上限), hence one in flight and rate-limited models kept.
export async function discoverSeekaiModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "SeekAI", url }));

  const data = await tryFetchJson<{ data?: SeekaiModel[] }>(url, {
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
