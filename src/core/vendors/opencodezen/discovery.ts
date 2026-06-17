import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface OpenCodeZenModel {
  id: string;
}

// OpenCode Zen serves a mixed free+paid catalog from one /v1/models list, but only
// the "-free" variants (and the big-pickle stealth model) work without an attached
// payment method; everything else 402s. Keep only the genuinely free ids so the
// probe never wastes time on paid models we cannot use.
const FREE_ONLY = (id: string): boolean =>
  id.endsWith("-free") || id === "big-pickle";

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
  const models = list.map((m) => m.id).filter(FREE_ONLY);
  return { models, maxOutputByModel: new Map() };
}
