import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface RequestyModel {
  id: string;
  api?: string;
  input_price?: number;
  output_price?: number;
  context_window?: number;
  max_output_tokens?: number;
}

// poolside/laguna-* return 200 but 0 content (broken upstream route); content-safety
// is a moderation model, not chat. Drop both from the free set.
const REQUESTY_DROP = /^poolside\/laguna|content-safety/;

// Requesty (router.requesty.ai/v1) - OpenRouter-style aggregator; base is the host,
// runner + discovery append /v1. Free tier = the input_price==0 && output_price==0
// chat models (200 RPD, no card). Wired as fallback dups for the shared free lanes.
export async function discoverRequestyModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Requesty", url }));

  const data = await tryFetchJson<{ data: RequestyModel[] } | RequestyModel[]>(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 15_000,
    },
  );

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of list) {
    if ((m.api ?? "chat") !== "chat") continue;
    if (m.input_price !== 0 || m.output_price !== 0) continue;
    if (REQUESTY_DROP.test(m.id)) continue;
    models.push(m.id);
    if (typeof m.max_output_tokens === "number" && m.max_output_tokens > 0) {
      maxOutputByModel.set(m.id, m.max_output_tokens);
    }
  }
  return { models, maxOutputByModel };
}
