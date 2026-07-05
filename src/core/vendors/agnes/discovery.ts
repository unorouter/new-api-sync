import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AgnesModel {
  id: string;
}

// Agnes AI (apihub.agnes-ai.com/v1) - Sapiens AI omni-modal gateway, OpenAI-compat.
// Base is the host, runner + discovery append /v1. /models returns the standard
// { data: [...] } envelope. House models only (agnes-*), no name-brand aliases.
export async function discoverAgnesModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Agnes AI", url }));

  const data = await tryFetchJson<{ data: AgnesModel[] } | AgnesModel[]>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const models = list.map((m) => m.id);
  return { models, maxOutputByModel: new Map() };
}
