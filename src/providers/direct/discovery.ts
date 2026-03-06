import { tryFetchJson } from "@/lib/http";
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
    throw new Error(
      "Anthropic has no model listing endpoint. Please provide an explicit 'models' array in the provider config.",
    );
  }

  if (vendor === "google") {
    const url = `${base}/v1beta/models?key=${apiKey}`;
    consola.info(`[discovery] Fetching Gemini models from ${base}/v1beta/models`);
    const data = await tryFetchJson<GeminiModelList>(url, { timeoutMs: 15_000 });
    if (!data?.models?.length) return [];
    return data.models.map((m) => m.name.replace(/^models\//, ""));
  }

  // Default: OpenAI-compatible /v1/models
  const endpoint = discoverEndpoint ?? "/v1/models";
  const url = `${base}${endpoint}`;
  consola.info(`[discovery] Fetching models from ${url}`);
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
