import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// api.lorebary.com/lorellm - LoreBary's built-in roleplay model behind a per-user key.
// /v1/models answers the site's HTML shell and the model field is ignored (every id,
// including the site's own sunblocker and skald, answers as LoreLLM), so the one id
// is listed here.
const SERVED = ["lorellm"] as const;

export async function discoverLorebaryModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "LoreBary",
      url: "static (no /v1/models)",
    }),
  );
  return { models: [...SERVED], maxOutputByModel: new Map() };
}
