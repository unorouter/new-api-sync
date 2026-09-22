import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface RoutewayModel {
  id: string;
}
interface RoutewayModelList {
  data: RoutewayModel[];
}

// api.routeway.ai. The free plan serves only the :free ids, 5 requests a minute
// and 200 a day across all of them per key; the rest of the catalog bills a
// balance this account does not hold.
export async function discoverRoutewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Routeway", url }));

  const data = await tryFetchJson<RoutewayModelList>(url, {
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
