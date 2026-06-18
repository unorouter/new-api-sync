import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface NscaleModel {
  id: string;
}

// Nscale (inference.api.nscale.com/v1) - serverless GPU cloud. PAYG (every model billed),
// $5 signup credit. 31 models: small/distill text (Qwen3, R1-Distills, Llama, gpt-oss,
// Kimi-K2.5) + image (FLUX/SDXL). Service token (nsk JWT, 3-month expiry - rotate). Standard
// OpenAI /models shape. Dynamic; probe drops any that fail. Wired as a cheap failover lane;
// pricing cap keeps every offer at-or-below canonical retail.
export async function discoverNscaleModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Nscale", url }));

  const data = await tryFetchJson<NscaleModel[] | { data: NscaleModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
