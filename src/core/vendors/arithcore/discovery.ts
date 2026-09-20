import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ArithcoreModel {
  id: string;
}

// api.arithcore.com - small relay (5 models) whose "Agens多模态免费" group serves agnes-2.5-flash
// at zero cost on an empty wallet. The model self-reports Sapiens AI / Agnes-2.5-Flash, matching
// the canonical agnes row the fleet already sells. Base is root; discovery appends /v1.
export async function discoverArithcoreModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Arithcore", url }));

  const data = await tryFetchJson<
    ArithcoreModel[] | { data: ArithcoreModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
