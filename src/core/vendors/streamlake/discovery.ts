import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// StreamLake (快手 Kuaishou / Vanchin, vanchin.streamlake.ai/api/gateway/coding/v1) - agentic
// coding models. NO API-key-readable model list: /v1/models + the gateway Action API both reject
// ("Missing Action"); the real catalog lives behind the cookie-auth console proxy
// (console.streamlake.ai/api/console/open-api/proxy?action=...), unreachable with just the API key.
// So discovery returns the full CANDIDATE endpoint set and the sync chat-probe decides what actually
// serves free: kat-coder-air-v1 serves (permanently free); kat-coder-pro-v1/v2 reject with
// UnaccessibleUser (Coding-Plan-gated) -> probe drops them. NOT a free-whitelist: if StreamLake ever
// frees pro, it auto-promotes. The "...-air"/"...-pro" bare + "kat-dev*" ids return "endpoint does
// not exist" and are excluded as invalid (not gated). Google/email signup, no real-name.
const CANDIDATE_MODELS = [
  "kat-coder-air-v1",
  "kat-coder-pro-v1",
  "kat-coder-pro-v2",
];

export async function discoverStreamLakeModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "StreamLake",
      url: "candidate KAT endpoints (no API-key /models; probe filters free)",
    }),
  );
  return { models: [...CANDIDATE_MODELS], maxOutputByModel: new Map() };
}
