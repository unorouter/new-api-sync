import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface LongCatModel {
  id: string;
}

// Meituan LongCat (api.longcat.chat/openai). First-party 美团 models (LongCat-Flash
// 560B MoE, open-sourced). Base ends at /openai; runner + discovery append /v1 ->
// /openai/v1/{models,chat/completions}. Public beta with a DAILY-REFRESHING free token
// quota (LongCat-2.0-Preview 5M tokens/day, up to 120M via feedback) and NO paid option
// at all - so a 429 "额度不足" means daily quota spent, not breakage. acceptRateLimited
// keeps quota-exhausted models (emitted disabled; new-api auto-test re-enables after the
// Beijing-midnight reset). Email/phone signup, no card, no +86 wall. Dynamic discovery.
export async function discoverLongCatModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "LongCat", url }));

  const data = await tryFetchJson<{ data?: LongCatModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = data?.data ?? [];
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
