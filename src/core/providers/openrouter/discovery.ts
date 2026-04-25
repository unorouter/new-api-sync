import { tryFetchJson } from "@core/runtime/http";
import { t } from "@server/i18n";
import { consola } from "consola";

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface OpenRouterModelList {
  data: OpenRouterModel[];
}

/**
 * Fetch OpenRouter's model catalogue and return IDs whose prompt+completion
 * pricing are both "0" (strings, as OpenRouter serialises them).
 *
 * The list is public, so the API key is only sent for consistency and to
 * count against the key's higher rate-limit bucket.
 */
export async function discoverOpenRouterFreeModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: t("CORE.PROVIDER.LABEL_OPENROUTER"),
      url,
    }),
  );

  const raw = await tryFetchJson<OpenRouterModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  if (!raw?.data?.length) return [];

  return raw.data
    .filter(
      (m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0",
    )
    .map((m) => m.id);
}
