import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ChatatModel {
  id: string;
}
interface ChatatModelList {
  data: ChatatModel[];
}

// cat1.coding-global.com, our proxy in front of ch.at (Deep AI Inc, keyless,
// bots welcome). The proxy exists because ch.at 400s on array content and sends
// no finish_reason or usage; it publishes one model, gpt-4o.
export async function discoverChatatModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "ch.at", url }));

  const data = await tryFetchJson<ChatatModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (m.id) models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
