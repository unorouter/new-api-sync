import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface BleakModel {
  id: string;
}

// Bleak HF Space (bleak-openai-compatible-server-gemma4.hf.space/v1). KEYLESS,
// genuinely SELF-HOSTED llama.cpp on the free HF CPU tier (Dockerfile builds the
// official ggml-org binary, no upstream proxy). Serves one honest unsloth Gemma-3n
// GGUF (owned_by:llamacpp, no frontier spoof). ~6 tok/s, single replica, cold-starts
// from sleep -> strictly a FALLBACK lane. The /v1/models response carries both a
// `models` array and an OpenAI-shaped `data` array; read `data`. Probe drops it when
// the Space is asleep/cold.
export async function discoverBleakModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Bleak", url }));

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "keyless") headers.Authorization = `Bearer ${apiKey}`;

  const data = await tryFetchJson<{ data?: BleakModel[] }>(url, {
    headers,
    timeoutMs: 30_000,
  });

  const list = data?.data ?? [];
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
