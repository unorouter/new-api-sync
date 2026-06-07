import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CohereModel {
  id: string;
}
interface CohereModelList {
  data: CohereModel[];
}

// Cohere's OpenAI-compatibility layer (api.cohere.ai/compatibility/v1) serves chat
// + text embeddings in OpenAI shape. Reranker uses a non-OpenAI /v1/rerank body,
// transcribe is Cohere-native, and *-image embeds need image input the text probe
// can't supply, so all three are dropped; the helper handles the rest.
function isExposable(id: string): boolean {
  const m = id.toLowerCase();
  if (m.startsWith("rerank-")) return false;
  if (m.includes("transcribe")) return false;
  if (m.includes("embed") && m.endsWith("-image")) return false;
  return true;
}

/**
 * Discover chat + text-embedding models from Cohere's OpenAI-compatibility
 * endpoint. Trial keys serve every listed model free (rate-limited). Embedding
 * ids contain "embed" so inferModelType routes them to /v1/embeddings.
 */
export async function discoverCohereModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Cohere", url }));

  const data = await tryFetchJson<CohereModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (!m.id || !isExposable(m.id)) continue;
    models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
