import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface WuhuModel {
  id: string;
}

// api.wuhu.lol - new-api relay, 734-model catalog. Its zero-cost lanes are the shared ":free"
// pool slugs (nemotron nano/super/ultra/lightning, cohere north-mini-code, dots-3-note-preview,
// laguna-xs-2.1), all already sold by the fleet, so this lane is failover capacity. The pools are
// shared, so a saturated upstream answers 429 as passthrough, not a key quota.
// Base is root; discovery appends /v1.
export async function discoverWuhuModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Wuhu", url }));

  const data = await tryFetchJson<WuhuModel[] | { data: WuhuModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
