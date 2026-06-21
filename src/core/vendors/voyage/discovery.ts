import type { ModelType } from "@core/types";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// Voyage AI (api.voyageai.com/v1). Top-tier retrieval embeddings, distinct from
// jina/cohere/siliconflow. 200M free text tokens per account, no card (payment only
// required AFTER the free allowance) -> genuine $0, not trial-credit. Base is the host;
// runner + discovery append /v1; the embedding modality probes /v1/embeddings. There is
// NO /v1/models (404), so discovery is a STATIC curated embedding list. rerank-2.5 is
// NOT OpenAI-shaped (/v1/rerank needs a bespoke channel) -> excluded here, embeddings only.
const VOYAGE_EMBEDDINGS = [
  "voyage-3",
  "voyage-3-lite",
  "voyage-code-3",
  "voyage-context-3",
  "voyage-multimodal-3.5",
];

export async function discoverVoyageModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "Voyage AI",
      url: "static embedding list (no /v1/models)",
    }),
  );
  // "voyage-*" names match no embedding name-pattern, so force the modality or the
  // helper probes /v1/chat/completions (404) instead of /v1/embeddings.
  const modelTypeHints = new Map<string, ModelType>(
    VOYAGE_EMBEDDINGS.map((m) => [m, "embedding"]),
  );
  return { models: VOYAGE_EMBEDDINGS, maxOutputByModel: new Map(), modelTypeHints };
}
