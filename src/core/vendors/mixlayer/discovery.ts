import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface MixlayerModel {
  id?: string;
  model_sku?: string;
}

// Mixlayer (models.mixlayer.ai/v1) - programmable inference platform, 8-model catalog but only
// qwen/qwen3.5-4b-free is free; the rest hard-block 402 insufficient_prepaid_credits with no
// card. Filter strictly to the -free suffix. Vendor-prefixed ids (bare-name strips qwen/).
export async function discoverMixlayerModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Mixlayer", url }));

  const data = await tryFetchJson<{ data: MixlayerModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const free = (data?.data ?? [])
    .map((m) => m.id ?? m.model_sku ?? "")
    .filter((id) => id.endsWith("-free"));
  return { models: free, maxOutputByModel: new Map() };
}
