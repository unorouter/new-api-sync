import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AbliterationModel {
  id: string;
}

// abliteration.ai (api.abliteration.ai/v1) - one uncensored/abliterated model
// (abliterated-model). Free tier credits, hard-stops at 0 with no card. OpenAI-compat,
// reasoning model (needs output budget), tool-calling + streaming verified.
export async function discoverAbliterationModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Abliteration", url }),
  );

  const data = await tryFetchJson<
    AbliterationModel[] | { data: AbliterationModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
