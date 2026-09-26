import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ApinexModel {
  id: string;
}
interface ApinexModelList {
  data: ApinexModel[];
}

// api.apinex.bond. Free ids carry a `free/` prefix; everything else bills a balance
// this key does not hold, and a few `free/` ids still demand a subscription.
export async function discoverApinexModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "APInex", url }));

  const data = await tryFetchJson<ApinexModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (m.id?.startsWith("free/")) models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
