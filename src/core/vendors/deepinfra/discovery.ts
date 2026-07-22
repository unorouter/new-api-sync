import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface DeepInfraModel {
  id: string;
}

// DeepInfra (api.deepinfra.com/v1/openai) - PAID PAYG inference, real per-token pricing.
// Standard OpenAI /models shape. Wired as a reliable paid GLM-5.2 lane (upstream cost
// ~$0.93/$3.00 per M; canonical retail caps it to market, netting margin). enabledModels
// (config) narrows to the single GLM-5.2 lane; probe drops any that fail.
export async function discoverDeepInfraModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "DeepInfra", url }));

  const data = await tryFetchJson<DeepInfraModel[] | { data: DeepInfraModel[] }>(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 15_000,
    },
  );

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
