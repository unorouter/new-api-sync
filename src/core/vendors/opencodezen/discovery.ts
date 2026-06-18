import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface OpenCodeZenModel {
  id: string;
}

// OpenCode Zen serves a mixed free+paid catalog from one /v1/models list. Expose
// everything and let the probe drop the paid models (they 402 without billing) -
// dynamic, so new free models are picked up automatically without editing a list.

export async function discoverOpenCodeZenModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "OpenCode Zen", url }),
  );

  const data = await tryFetchJson<
    OpenCodeZenModel[] | { data: OpenCodeZenModel[] }
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
