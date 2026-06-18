import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface OllamaModel {
  id: string;
}

// Ollama Cloud (ollama.com/v1) - OpenAI-compat. 35 models but ~14 are subscription-gated
// (deepseek-v4/v3.2, kimi-k2.x, glm-5.x, gemini-fake, mistral-large-3, qwen3.5-397b) and 402
// "requires a subscription"; the probe drops them. Free ~21: gpt-oss, gemma3/4, minimax-m2.x/m3,
// nemotron-3-*, qwen3-coder, ministral-3, devstral, rnj-1. Free tier is GPU-time metered (5h +
// weekly reset, no quota readout). Static key via ollama.com/settings/keys (GitHub OAuth).
// Names use ":tag" sizing (gpt-oss:120b) - config modelMapping rewrites those to dash canonicals
// (gpt-oss-120b) so they group across providers + bare-naming keeps the size.
export async function discoverOllamaModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Ollama Cloud", url }));

  const data = await tryFetchJson<OllamaModel[] | { data: OllamaModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
