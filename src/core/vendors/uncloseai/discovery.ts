import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface UncloseModel {
  id: string;
  max_model_len?: number;
}

// UncloseAI / unturf permacomputer (hermes.ai.unturf.com/v1). Community-hosted, vllm-served,
// KEYLESS (no signup, no card). Base is the host; runner + discovery append /v1. The chat
// endpoint serves Hermes-3-Llama-3.1-8B (Nous Research, RP-capable). Sibling hosts (qwen
// closed, speech TTS) are separate subdomains, not this channel. Dynamic; probe drops failures.
export async function discoverUncloseAiModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "UncloseAI", url }));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey && apiKey !== "keyless")
    headers.Authorization = `Bearer ${apiKey}`;

  const data = await tryFetchJson<{ data?: UncloseModel[] }>(url, {
    headers,
    timeoutMs: 15_000,
  });

  const list = data?.data ?? [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of list)
    if (m.max_model_len) maxOutputByModel.set(m.id, m.max_model_len);
  return { models: list.map((m) => m.id), maxOutputByModel };
}
