import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface GonkaBrokerModel {
  id: string;
}
interface GonkaBrokerModelList {
  data: GonkaBrokerModel[];
}

// proxy.gonkabroker.com, a USD billed front for the Gonka network. The free tier
// (monthly token grant, 6 requests a minute) needs a phone verified account. The
// catalog also lists bge-m3, an embedding model the chat tester cannot pass.
export async function discoverGonkaBrokerModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Gonka Broker", url }));

  const data = await tryFetchJson<GonkaBrokerModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (m.id && !/bge/i.test(m.id)) models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
