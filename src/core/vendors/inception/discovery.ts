import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface InceptionModel {
  id: string;
}

// Inception Labs (api.inceptionlabs.ai/v1) - Mercury diffusion LLM (mercury-2), a
// distinct dLLM architecture (not a transformer dup). 10M free tokens, no card,
// hard-stops when exhausted. OpenAI-compat, tool-calling verified.
export async function discoverInceptionModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Inception", url }));

  const data = await tryFetchJson<InceptionModel[] | { data: InceptionModel[] }>(
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
