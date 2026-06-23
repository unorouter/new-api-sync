import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface LlmGatewayModel {
  id: string;
  free?: boolean;
  context_size?: number;
  max_output?: number;
}

// LLM Gateway (theopenco, api.llmgateway.io/v1). No-card signup mints the key.
// 224-model mixed catalog; discovery filters to the free:true subset (~3 GLM-Flash
// rows, all served via the zai upstream: glm-4.5-flash, glm-4.7-flash-free,
// glm-4.6v-flash vision). Free models honestly labeled (no faked frontier). The free
// lane rides zai's shared RPM -> 429 "1302 Rate limit" = budget spent, not broken
// (acceptRateLimited keeps it). 20 rpm free cap. Base is the host; runner + discovery
// append /v1.
export async function discoverLlmGatewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "LLM Gateway", url }),
  );

  const data = await tryFetchJson<{ data?: LlmGatewayModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const free = (data?.data ?? []).filter((m) => m.free === true);
  const maxOutputByModel = new Map<string, number>();
  for (const m of free) {
    const out = m.max_output ?? m.context_size;
    if (out) maxOutputByModel.set(m.id, out);
  }
  return { models: free.map((m) => m.id), maxOutputByModel };
}
