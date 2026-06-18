import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AionModel {
  id: string;
}

// Aion Labs (api.aionlabs.ai/v1). /v1/models returns a { models: [...] } envelope
// (not the OpenAI { data: [...] } shape). 5 models (aion-1.0/-mini/-2.0/-2.5 + the
// aion-rp RP finetune); the probe drops whichever stop serving free. No curation.
export async function discoverAionLabsModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Aion Labs", url }));

  const data = await tryFetchJson<{
    models?: AionModel[];
    data?: AionModel[];
  }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = data?.models ?? data?.data ?? [];
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
