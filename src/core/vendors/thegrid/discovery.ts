import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// TheGrid (api.thegrid.ai/v1) - agentic router, rate-limited FREE tier (x-ratelimit 5/window, no
// card). Uses a 307-redirect to a signed /r/ endpoint (Go http.Client preserves the POST body on
// 307, so new-api relays it). Expose only the stable text tiers (agent/code preview tiers skipped);
// they route to real frontier models (text-max -> claude-opus-4-8, prime -> minimax-m3, standard ->
// gpt-oss-120b), collapsed to canonical names via config modelMapping. Authenticity probe guards the
// claude tier. Hardcoded (not discovered) so a preview-catalog change can't leak an untested id.
const TEXT_TIERS = ["text-standard", "text-prime", "text-max"];

export async function discoverTheGridModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "TheGrid",
      url: "(fixed text tiers)",
    }),
  );
  return { models: TEXT_TIERS, maxOutputByModel: new Map() };
}
