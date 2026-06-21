import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface PublicAiModel {
  id: string;
}

// Public AI Inference Utility (api.publicai.co/v1). Nonprofit, donated-GPU + ad-subsidy
// funded - "completely free" with a flat 20 RPM cap, NO balance, NO paid tier. Base is
// the host; runner + discovery append /v1. Serves sovereign open models (swiss-ai Apertus
// 8b/70b, allenai Olmo-3.x, aisingapore SEA-LION-v4, EuroLLM, DictaLM) + Cohere embed/rerank.
// Docs ask for a User-Agent to deter bots (not enforced, but sent for politeness). The flat
// 20 RPM trips 429 under burst probing -> acceptRateLimited keeps the model. Direct key
// bypasses the wired HF router, so this is a distinct lane.
export async function discoverPublicAiModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Public AI", url }));

  const data = await tryFetchJson<{ data?: PublicAiModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "unorouter-sync/1.0",
    },
    timeoutMs: 15_000,
  });

  const list = data?.data ?? [];
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
