import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface DeepInfraModel {
  id: string;
}

interface DeepInfraPricedModel {
  model_name: string;
  pricing?: {
    cents_per_input_token?: number;
    cents_per_output_token?: number;
  };
}

// new-api per-token base: model_ratio 1 == $2/M input tokens. DeepInfra prices in
// cents PER TOKEN, so $/M = cents_per_input_token * 1e6 / 100, and ratio = $/M / 2.
const USD_PER_M_PER_RATIO = 2;

// DeepInfra (api.deepinfra.com) - PAID PAYG inference, real per-token pricing. /v1/models
// gives the OpenAI id list; /models/list gives per-token cost. We wire the real cost as
// upstreamRatio so a paid lane prices off DeepInfra's actual cost (not a $2/M default),
// and an explicit positive priceAdjustment on the model bills cost * (1 + adj).
export async function discoverDeepInfraModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "DeepInfra", url }));

  const data = await tryFetchJson<
    DeepInfraModel[] | { data: DeepInfraModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);

  const ratioByModel = new Map<string, number>();
  const completionRatioByModel = new Map<string, number>();
  const priced = await tryFetchJson<DeepInfraPricedModel[]>(
    `${base}/models/list`,
    { timeoutMs: 15_000 },
  );
  for (const m of priced ?? []) {
    const cin = m.pricing?.cents_per_input_token;
    const cout = m.pricing?.cents_per_output_token;
    if (cin === undefined || cin <= 0) continue;
    const inputUsdPerM = (cin * 1_000_000) / 100;
    ratioByModel.set(m.model_name, inputUsdPerM / USD_PER_M_PER_RATIO);
    if (cout !== undefined && cout > 0)
      completionRatioByModel.set(m.model_name, cout / cin);
  }

  return {
    models: list.map((m) => m.id),
    maxOutputByModel: new Map(),
    ratioByModel,
    completionRatioByModel,
  };
}
