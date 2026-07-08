import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface JiekouModel {
  id: string;
}

// Jiekou / Interface AI (api.jiekou.ai/openai/v1) - multi-vendor relay, 172 models across
// every family (Claude/GPT/Gemini/Grok/Qwen/GLM/DeepSeek/...). Free daily quota (calls work
// at $0 cash balance); no card = hard-stops when quota drains. Mixed naming (namespaced +
// bare Claude + -r reasoning variants). Authenticity probes drop faked closed-model channels.
export async function discoverJiekouModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Jiekou", url }));

  const data = await tryFetchJson<JiekouModel[] | { data: JiekouModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
