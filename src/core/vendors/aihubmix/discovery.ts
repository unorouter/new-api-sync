import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AiHubMixModel {
  id: string;
}

// AIHubMix serves a 340+ mixed free+paid catalog. The subsidized free lane is the
// "-free" suffix subset: $0 per call (verified - calls don't bill the balance),
// gated only by an anti-abuse rule that grants 10 trial calls until ANY top-up is
// present, after which the "-free" models stay free indefinitely under per-model
// daily caps. Filter to "-free"; the probe drops any "-free" id the gateway lists
// but won't actually serve.

export async function discoverAiHubMixModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "AIHubMix", url }));

  const data = await tryFetchJson<
    AiHubMixModel[] | { data: AiHubMixModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const free = list.map((m) => m.id).filter((id) => /-free$/i.test(id));
  return { models: free, maxOutputByModel: new Map() };
}
