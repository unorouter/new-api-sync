import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// BazaarLink (bazaarlink.ai/api/v1) is an OpenRouter-mirror reseller: 295 models,
// but exactly ONE is free - the routing id "auto:free", which serves whichever
// capable model is currently $0 (verified: routes to deepseek-v4-flash, cost 0,
// no card). Every other model hard-gates behind 402 credits. So discovery is
// static: just expose "auto:free". Brand-new low-trust vendor, treat as disposable
// failover - the probe drops it if the free lane ever vanishes.

export async function discoverBazaarLinkModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "BazaarLink",
      url: "auto:free (static)",
    }),
  );
  return { models: ["auto:free"], maxOutputByModel: new Map() };
}
