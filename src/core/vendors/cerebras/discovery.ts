import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CerebrasModel {
  id: string;
  max_completion_tokens?: number;
  context_window?: number;
}
interface CerebrasModelList {
  data: CerebrasModel[];
}

/** Discover models + per-model output caps from Cerebras's OpenAI-compatible endpoint. */
export async function discoverCerebrasModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "Cerebras",
      url,
    }),
  );

  const data = await tryFetchJson<CerebrasModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data?.data ?? []) {
    models.push(m.id);
    const cap = m.max_completion_tokens ?? m.context_window;
    if (typeof cap === "number" && cap > 0) maxOutputByModel.set(m.id, cap);
  }
  return { models, maxOutputByModel };
}
