import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface GroqModel {
  id: string;
  active?: boolean;
  context_window?: number;
  max_completion_tokens?: number;
}
interface GroqModelList {
  data: GroqModel[];
}

/** Discover available models + per-model output caps from Groq's OpenAI-compatible endpoint. */
export async function discoverGroqModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: t("CORE.PROVIDER.LABEL_GROQ"),
      url,
    }),
  );

  const data = await tryFetchJson<GroqModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data?.data ?? []) {
    if (m.active === false) continue;
    models.push(m.id);
    const cap = m.max_completion_tokens ?? m.context_window;
    if (typeof cap === "number" && cap > 0) maxOutputByModel.set(m.id, cap);
  }
  return { models, maxOutputByModel };
}
