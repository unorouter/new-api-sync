import { tryFetchJson } from "@core/runtime/http";
import { t } from "@server/i18n";
import { consola } from "consola";

interface OpenAIModelList {
  data: { id: string }[];
}

interface GeminiModelList {
  models: { name: string }[];
}

/**
 * Discover available models from a direct provider API.
 *
 * Strategy by vendor:
 * - "google" (Gemini): GET /v1beta/models with ?key= auth
 * - "anthropic": no listing endpoint, throws requiring explicit models
 * - Default (OpenAI-compatible): GET /v1/models with Bearer auth
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  vendor: string,
  discoverEndpoint?: string,
): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, "");

  if (vendor === "anthropic") {
    throw new Error(t("ERROR.DIRECT_ANTHROPIC_NO_LIST_ENDPOINT"));
  }

  if (vendor === "google") {
    const url = `${base}/v1beta/models?key=${apiKey}`;
    consola.info(
      t("CORE.PROVIDER.DISCOVERY_FETCH", {
        label: t("CORE.PROVIDER.LABEL_GEMINI"),
        url: `${base}/v1beta/models`,
      }),
    );
    const data = await tryFetchJson<GeminiModelList>(url, {
      timeoutMs: 15_000,
    });
    if (!data?.models?.length) return [];
    return data.models.map((m) => m.name.replace(/^models\//, ""));
  }

  // Default: OpenAI-compatible /v1/models
  const endpoint = discoverEndpoint ?? "/v1/models";
  const url = `${base}${endpoint}`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: vendor, url }),
  );
  const data = await tryFetchJson<OpenAIModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });
  if (!data?.data?.length) return [];
  return data.data.map((m) => m.id);
}
