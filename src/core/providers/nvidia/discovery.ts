 import { tryFetchJson } from "@core/lib/http";
import { consola } from "consola";

interface OpenAIModelList {
  data: { id: string }[];
}

/**
 * Discover available text models from NVIDIA NIM's OpenAI-compatible endpoint.
 * Image models are on a separate host and not discoverable via this endpoint.
 */
export async function discoverNvidiaModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(`[discovery] Fetching NVIDIA NIM models from ${url}`);

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
