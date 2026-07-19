import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// NemoRouter (api.nemorouter.ai/v1) - LiteLLM-backed unified gateway, 114 models at official
// list price (no discount), $10 signup credit. Only worth pulling the cheap open models that
// stretch the credit: Kimi-K2.6 (RP, verified clean English) + DeepSeek-V4-Flash (cheapest
// premium). glm-5.2 is listed but 500s (upstream Vertex ADC misconfig), so excluded. Frontier
// (opus/gpt-5.5) burns $10 in ~300 turns - not worth it. Upstream names are mixed-case; exposed
// canonical dot-form maps back via modelMapping. Credit drains then 402-auto-disables.
const MODELS = ["Kimi-K2.6", "Kimi-K2.7-Code", "DeepSeek-V4-Flash"];

export async function discoverNemoRouterModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "NemoRouter",
      url: "(curated cheap-premium subset)",
    }),
  );
  return { models: MODELS, maxOutputByModel: new Map() };
}
