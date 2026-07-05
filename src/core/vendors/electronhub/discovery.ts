import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ElectronHubModel {
  id: string;
  endpoints?: string[];
  premium_model?: boolean;
  tokens?: { context?: number };
}

// ElectronHub (api.electronhub.ai/v1) - OpenAI-compat aggregator. Only the ":free"
// chat models are genuinely free (phone-verified account required); image models
// are per-image PAID against the credit balance, so we take chat only. Base is the
// host, runner + discovery append /v1.
export async function discoverElectronHubModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "ElectronHub", url }));

  const data = await tryFetchJson<{ data: ElectronHubModel[] } | ElectronHubModel[]>(
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
    if (!m.id.endsWith(":free")) continue;
    const eps = m.endpoints ?? [];
    if (!eps.includes("/v1/chat/completions")) continue;
    models.push(m.id);
    const ctx = m.tokens?.context;
    if (typeof ctx === "number" && ctx > 0) maxOutputByModel.set(m.id, ctx);
  }
  return { models, maxOutputByModel };
}
