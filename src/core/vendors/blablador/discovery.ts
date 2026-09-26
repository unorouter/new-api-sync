import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// api.blablador.fz-juelich.de - FZ Juelich's research inference service. /v1/models
// mixes display names ("90 - Kimi-K3 1M on Juwels Booster"), staging aliases and
// OpenAI legacy stubs, so only the aliases that answered as the named model are
// listed; config modelMapping folds them onto the published names.
const SERVED = [
  "alias-kimi-k3-1m",
  "alias-deepseek-v41-flash-booster",
  "alias-mimo-v2.6-pro",
  "alias-mimo-v2.6-flash",
  "alias-qwen3.8-flash-next",
  "alias-qwen3.8-27b",
] as const;

export async function discoverBlabladorModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "Blablador",
      url: "static (curated aliases)",
    }),
  );
  return { models: [...SERVED], maxOutputByModel: new Map() };
}
