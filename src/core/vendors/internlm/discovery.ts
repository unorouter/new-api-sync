import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface InternLmModel {
  id: string;
}

// InternLM 书生 (Shanghai AI Lab, chat.intern-ai.org.cn/api/v1) - OpenAI-compat. ~90M tokens/month
// free. Own models: internlm3-latest, internvl2.5-latest (vision). Base ends at /api; runner +
// discovery append /v1. GitHub/email signup (no real-name). Dynamic; probe drops any that fail.
export async function discoverInternLmModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "InternLM", url }));

  const data = await tryFetchJson<InternLmModel[] | { data: InternLmModel[] }>(
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
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
