import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface SenseNovaModel {
  id: string;
}

// SenseNova 商汤 (token.sensenova.cn/v1) - SenseTime Token Plan, free public beta. 1500 calls/5h
// per model, refreshing. Serves sensenova-6.7/6.8-flash-lite (both reasoning models that answer
// with an empty content and a populated reasoning field) plus resold deepseek-v4-flash and
// glm-5.2. OpenAI-compat. Base ends at root; runner + discovery append /v1.
// +86-phone signup (no real-name). Dynamic; probe drops any that fail.
export async function discoverSenseNovaModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "SenseNova", url }));

  const data = await tryFetchJson<
    SenseNovaModel[] | { data: SenseNovaModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  // /v1/models advertises models the account cannot actually call: u1-fast is
  // listed but every request to it answers "model is not found" (404), on both
  // the streaming and non-streaming paths. The probe accepts it because this
  // provider sets acceptRateLimited and a throttled probe reads as transient,
  // so the dead lane has to be dropped here rather than left to testing.
  const unusable = new Set(["sensenova-u1-fast"]);
  return {
    models: list.map((m) => m.id).filter((id) => !unusable.has(id)),
    maxOutputByModel: new Map(),
  };
}
