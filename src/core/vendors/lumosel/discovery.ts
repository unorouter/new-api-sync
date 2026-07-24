import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface LumoselModel {
  id: string;
}

// Lumosel (api.lumosel.vip) - free credit relay, ANTHROPIC-native: only /v1/messages
// works (x-api-key auth); /v1/chat/completions 404s -> channelType 14. /api/models lists
// the free catalog (claude fable/opus/sonnet, glm-5.2, gpt-5.6 variants). Base is root;
// new-api appends /v1/messages. Authenticity probe fingerprints by vendor.
export async function discoverLumoselModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/api/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Lumosel", url }));

  const data = await tryFetchJson<{ models?: LumoselModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  return {
    models: (data?.models ?? []).map((m) => m.id),
    maxOutputByModel: new Map(),
  };
}
