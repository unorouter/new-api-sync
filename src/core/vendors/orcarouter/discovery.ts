import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// OrcaRouter (www.orcarouter.ai/v1) - new-api relay with a funded account, so PAID models bill.
// Expose ONLY the free auto-router meta-models (orcarouter/free + fusion tiers), which are not in
// the paid /api/pricing list and route to whatever free upstream the relay picks. Hardcoded (not
// discovered) so a catalog change on their side can never leak a paid model into our free lane.
const FREE_ROUTERS = [
  "orcarouter/free",
  "orcarouter/fusion",
  "orcarouter/fusion-flash",
  "orcarouter/fusion-mini",
];

export async function discoverOrcaRouterModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "OrcaRouter",
      url: "(fixed free routers)",
    }),
  );
  return { models: FREE_ROUTERS, maxOutputByModel: new Map() };
}
