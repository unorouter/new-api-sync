import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface WandbModel {
  id: string;
}

// Weights & Biases Inference (api.inference.wandb.ai/v1) - serverless hosted models.
// 29 frontier: GLM-5.x, Kimi-K2.5/2.6/2.7, DeepSeek-V4-pro/flash/V3.1, Qwen3-Coder-480B,
// Qwen3-235B, MiniMax-M2.5, Nemotron-3-super/ultra, Llama, gpt-oss, granite, phi. Ids are
// vendor-namespaced + mixed-case (zai-org/GLM-5.2); bare-name resolve strips the prefix
// and lowercases. Free while the plan's monthly inference credit lasts; hard-stops with
// no card on file. OpenAI-compat, tool-calling verified.
export async function discoverWandbModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "W&B Inference", url }),
  );

  const data = await tryFetchJson<WandbModel[] | { data: WandbModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
