import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface KiroModel {
  id: string;
}
interface KiroModelList {
  data: KiroModel[];
}

// Kiro IDE (AWS CodeWhisperer) reverse, OpenAI-compat /v1/models. The proxy
// publishes whatever the account's subscription entitles it to, so the free
// tier's Sonnet 4.5 and the paid tiers' larger catalog both arrive here.
export async function discoverKiroModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Kiro", url }));

  const data = await tryFetchJson<KiroModelList>(url, {
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
