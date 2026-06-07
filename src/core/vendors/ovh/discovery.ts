import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface OvhModel {
  id: string;
  max_model_len?: number;
  context_length?: number;
}
interface OvhModelList {
  data: OvhModel[];
}

/**
 * Discover models from OVHcloud AI Endpoints (OpenAI-compatible /v1/models). The
 * anonymous tier needs no key (2 req/min per IP per model); a placeholder apiKey
 * is sent and ignored. The list mixes text/embedding/audio/image models, which the
 * shared helper splits by inferred modality.
 */
export async function discoverOvhModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "OVHcloud", url }));

  const data = await tryFetchJson<OvhModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data?.data ?? []) {
    if (!m.id) continue;
    models.push(m.id);
    const cap = m.max_model_len ?? m.context_length;
    if (typeof cap === "number" && cap > 0) maxOutputByModel.set(m.id, cap);
  }
  return { models, maxOutputByModel };
}
