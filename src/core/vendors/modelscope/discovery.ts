import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ModelScopeModel {
  id: string;
}
interface ModelScopeModelList {
  data: ModelScopeModel[];
}

// api-inference.modelscope.ai (international site). Inference needs the account
// bound to a real-name verified Alibaba Cloud account, and each call spends
// Magicubes (about 1 to 2 per call) from a daily grant, so config keeps the
// catalog to a few frontier ids with enabledModels.
export async function discoverModelScopeModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "ModelScope", url }));

  const data = await tryFetchJson<ModelScopeModelList>(url, {
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
