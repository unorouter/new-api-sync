import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface VertexCgModel {
  id: string;
}
interface VertexCgModelList {
  data: VertexCgModel[];
}

// Google's anonymous Agent Platform Studio endpoint reversed, OpenAI-compat
// /v1/models. Each id is published three times upstream (bare, 假流式- and
// fake- streaming variants); only the bare name is a distinct model.
export async function discoverVertexCgModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Vertex-CG", url }));

  const data = await tryFetchJson<VertexCgModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (!m.id) continue;
    if (m.id.startsWith("假流式-") || m.id.startsWith("fake-")) continue;
    models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
