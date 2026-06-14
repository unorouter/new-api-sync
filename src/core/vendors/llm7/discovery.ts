import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface Llm7Model {
  id: string;
  context_window?: { tokens?: number | null };
}

// LLM7's /v1/models returns a bare array (not the OpenAI { data: [...] } envelope).
export async function discoverLlm7Models(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "LLM7", url }));

  const data = await tryFetchJson<Llm7Model[] | { data: Llm7Model[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of list) {
    models.push(m.id);
    const cap = m.context_window?.tokens;
    if (typeof cap === "number" && cap > 0) maxOutputByModel.set(m.id, cap);
  }
  return { models, maxOutputByModel };
}
