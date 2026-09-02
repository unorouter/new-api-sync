import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AmdModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
}

const USD_PER_M_PER_RATIO = 2;

// AMD Radeon developer gateway (developer.amd.com.cn/radeon/api/v1). OpenRouter-shaped
// catalog of self-deployed sglang/vllm models (DeepSeek-V4-Flash, Qwen3.8-Flash-Next,
// MiniCPM5-1B). Listing carries per-token USD prices and /v1/key reports limit:null, so
// the real cost is wired as ratioByModel for any model later marked paid. Base is root; /v1 appended.
export async function discoverAmdModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "AMD", url }));

  const data = await tryFetchJson<{ data: AmdModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = data?.data ?? [];
  const ratioByModel = new Map<string, number>();
  const completionRatioByModel = new Map<string, number>();
  for (const m of list) {
    const pin = Number(m.pricing?.prompt);
    const pout = Number(m.pricing?.completion);
    if (!(pin > 0)) continue;
    ratioByModel.set(m.id, (pin * 1_000_000) / USD_PER_M_PER_RATIO);
    if (pout > 0) completionRatioByModel.set(m.id, pout / pin);
  }

  return {
    models: list.map((m) => m.id),
    maxOutputByModel: new Map(),
    ratioByModel,
    completionRatioByModel,
  };
}
