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
 * Fetch OpenRouter's model catalogue and return both:
 *  - free model IDs (prompt+completion both "0")
 *  - the full set of known IDs with their free/paid status, so the provider
 *    can classify enabledModels extras (e.g. `moonshotai/kimi-k2.6` is paid;
 *    `:free` variants are free).
 *
 * The list is public, so the API key is only sent for consistency and to
 * count against the key's higher rate-limit bucket.
 */
export interface OpenRouterCatalogue {
  freeIds: string[];
  /** id → true if free (prompt and completion both "0"), false if paid. */
  isFreeById: Map<string, boolean>;
}

export async function discoverOpenRouterFreeModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenRouterCatalogue> {
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

  if (!raw?.data?.length) return { freeIds: [], isFreeById: new Map() };

  const isFreeById = new Map<string, boolean>();
  const freeIds: string[] = [];
  for (const m of raw.data) {
    const free = m.pricing?.prompt === "0" && m.pricing?.completion === "0";
    isFreeById.set(m.id, free);
    if (free) freeIds.push(m.id);
  }
  return { freeIds, isFreeById };
}
