import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface QiniuModel {
  id: string;
}

// Qiniu (七牛, openai.qiniu.com/v1) - the only domestic CN platform officially serving
// OpenAI/Claude/Gemini. 65 frontier models: deepseek-v4-pro/flash, kimi-k2.5/2.6/2.7,
// glm-5/5.1/5.2, minimax-m2.5/2.7/m3, qwen3.7-max, doubao, mimo, hy3, nemotron, longcat,
// + anthropic/claude-fable-5 (gpt/gemini live in the resource-pack). 3M free tokens/year.
// Dual OpenAI + Anthropic protocol. Email signup (intl, no CN phone) + real-name. Vendor-
// prefixed ids (deepseek/, z-ai/, moonshotai/) bare-name-collapse into our canonicals.
// Dynamic; probe drops any faked/gated model (claude-fable authenticity verified at sync).
export async function discoverQiniuModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Qiniu", url }));

  const data = await tryFetchJson<QiniuModel[] | { data: QiniuModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
