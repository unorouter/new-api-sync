import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface HfProvider {
  provider: string;
  status?: string;
  context_length?: number;
}
interface HfModel {
  id: string;
  architecture?: { output_modalities?: string[] };
  providers?: HfProvider[];
}
interface HfModelList {
  data: HfModel[];
}

// Discover chat models from HuggingFace's OpenAI-compatible router. The router
// fans each bare `org/Model` id out to whichever upstream provider (novita,
// nebius, together, fireworks, ...) is fastest, so we expose the bare id and let
// HF route. Skip models with no live provider or no text output; context cap is
// the max context_length across live providers.
export async function discoverHuggingFaceModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "HuggingFace", url }),
  );

  const data = await tryFetchJson<HfModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data?.data ?? []) {
    const live = (m.providers ?? []).filter((p) => p.status === "live");
    if (live.length === 0) continue;
    if (!(m.architecture?.output_modalities ?? ["text"]).includes("text"))
      continue;
    models.push(m.id);
    const cap = Math.max(...live.map((p) => p.context_length ?? 0));
    if (cap > 0) maxOutputByModel.set(m.id, cap);
  }
  return { models, maxOutputByModel };
}
