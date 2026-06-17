import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// FreeModel (api.freemodel.dev) advertises a big catalog but ONLY actually serves
// a few GPT-5.x models: every other name (claude/o3/gemini/gpt-5.3-codex) is silently
// routed to gpt-5.4 (the response `model` field gives it away, and the sync's
// authenticity probe rejects them anyway). So we expose ONLY the names that return
// themselves - the honest, distinct GPT-5.x rows. 1-month Pro trial then tightens.
const CURATED = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

export async function discoverFreeModelModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "FreeModel",
      url: "curated list",
    }),
  );
  return { models: [...CURATED], maxOutputByModel: new Map() };
}
