import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AxztModel {
  id: string;
}

// ai.axzt.top - relay whose default group prices Qwen at 0: the call returns 200 and the wallet
// does not move (10000 before and after), and the model answers "Alibaba" and names itself
// qwen3.6-plus. Only that lane is enabled in config: this relay also lists the same weights as
// "Qwen3-Max-Thinking-Preview", which self-reports qwen3.6-plus too, so publishing it would sell
// a mislabelled premium name. Its Kimi/GLM/Coder lanes answer 500/503.
// Base is root; discovery appends /v1.
export async function discoverAxztModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Axzt", url }));

  const data = await tryFetchJson<AxztModel[] | { data: AxztModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
