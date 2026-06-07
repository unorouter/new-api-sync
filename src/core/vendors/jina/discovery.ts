import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface JinaModel {
  id: string;
  input_modalities?: string[];
  context_length?: number;
}
interface JinaModelList {
  data: JinaModel[];
}

// /v1/models returns org-prefixed ids ("jina-ai/jina-embeddings-v3") but the
// /v1/embeddings API rejects the prefix and wants the bare id. Strip it here.
const stripOrg = (id: string) => id.replace(/^jina-ai\//, "");

// Keep only text-in embedding models. clip-v* take image input, rerankers use a
// non-OpenAI /v1/rerank shape, ReaderLM/VLM are generation models, none of which
// flow through the OpenAI /v1/embeddings surface we expose.
function isExposableEmbedding(id: string): boolean {
  const bare = stripOrg(id).toLowerCase();
  if (!/embedding|embeddings/.test(bare)) return false;
  if (bare.includes("clip")) return false;
  return true;
}

/**
 * Discover Jina text-embedding models from the OpenAI-compatible endpoint
 * (api.jina.ai/v1). Key carries a 10M-token free grant; embeddings route through
 * /v1/embeddings with bare model ids.
 */
export async function discoverJinaModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Jina", url }));

  const data = await tryFetchJson<JinaModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (!m.id || !isExposableEmbedding(m.id)) continue;
    models.push(stripOrg(m.id));
  }
  return { models, maxOutputByModel: new Map() };
}
