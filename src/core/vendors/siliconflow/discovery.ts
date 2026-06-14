import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface SfModel {
  id: string;
}
interface SfModelList {
  data: SfModel[];
}

// Discover models from SiliconFlow's OpenAI-compatible endpoint. The list is
// bare ids (no per-model caps), so output caps are left to the runner default.
export async function discoverSiliconFlowModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "SiliconFlow", url }),
  );

  const data = await tryFetchJson<SfModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models = (data?.data ?? []).map((m) => m.id);
  return { models, maxOutputByModel: new Map() };
}
