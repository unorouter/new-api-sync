import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CfpModel {
  id: string;
}
interface CfpModelList {
  data: CfpModel[];
}

// Cloudflare AI Playground reverse (our own Bun proxy, keyless: no account, no
// API key, no cookie). The proxy publishes upstream's own vendor/model slugs
// verbatim and config modelMapping collapses them onto the canonical names, so
// this lane lands as extra fallback capacity in pools we already serve rather
// than as a parallel set of near-duplicate ids.
export async function discoverCfpModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "cfp", url }));

  const data = await tryFetchJson<CfpModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (m.id) models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
