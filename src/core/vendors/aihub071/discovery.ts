import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AihubModel {
  id: string;
}

// aihub.071129.xyz - new-api relay with a 295-model catalog whose zero-cost lanes keep serving
// on an empty wallet (verified by balance delta). Ten of them answer: DeepSeek-V4-Flash plus the
// usual ":free" pool slugs (nemotron ultra/super/nano, nex-agi, cohere, ling, laguna), all of
// which the fleet already sells, so this lane is failover capacity. The free pools are shared,
// so a saturated upstream answers 429 as passthrough rather than a key quota.
// Base is root; discovery appends /v1.
export async function discoverAihub071Models(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "AIHub071", url }));

  const data = await tryFetchJson<AihubModel[] | { data: AihubModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
