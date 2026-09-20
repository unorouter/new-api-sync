import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface KlModel {
  id: string;
}
interface KlModelList {
  data: KlModel[];
}

// kilocode.ai reverse (kilo2api, keyless). The binary rebuilds its registry from
// OpenRouter at boot and publishes all 374 ids, but only the :free ones answer
// without a kilocode profile token: the rest come back PAID_MODEL_AUTH_REQUIRED.
export async function discoverKlModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Kilo Code", url }));

  const data = await tryFetchJson<KlModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (m.id && /:free$/.test(m.id)) models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
