import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface MistralModel {
  id: string;
  max_context_length?: number;
  capabilities?: { completion_chat?: boolean; embeddings?: boolean };
}
interface MistralModelList {
  data: MistralModel[];
}

/**
 * Discover chat + embedding models from Mistral's OpenAI-compatible endpoint.
 * Mistral's list mixes in OCR/audio/FIM/moderation too, so keep only models that
 * report completion_chat or embeddings; the rest are dropped.
 */
export async function discoverMistralModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Mistral", url }));

  const data = await tryFetchJson<MistralModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data?.data ?? []) {
    const caps = m.capabilities;
    // Mistral has no "embeddings" capability flag; embed models report all caps
    // false, so detect them by id. Keep chat OR embed; drop OCR/audio/FIM/moderation.
    const isEmbed = /embed/i.test(m.id);
    if (caps && caps.completion_chat === false && !isEmbed) continue;
    models.push(m.id);
    if (typeof m.max_context_length === "number" && m.max_context_length > 0)
      maxOutputByModel.set(m.id, m.max_context_length);
  }
  return { models, maxOutputByModel };
}
