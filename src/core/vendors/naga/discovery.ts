import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface NagaModel {
  id: string;
}

// NagaAI (api.naga.ac/v1) - multi-vendor gateway. The key's free tier exposes ~11 :free
// models across chat (nemotron-3-ultra/super, llama-3.3-70b, llama-4-scout, sonar), image
// (dall-e-3, flux-1-schnell, sdxl) + audio (eleven-multilingual-v2 TTS, gpt-4o-mini-tts,
// whisper-large-v3 STT). /v1/models already returns only the tier-visible set, so dynamic -
// the probe drops any flaky/capacity-gated ones (e.g. the 550B ultra).
export async function discoverNagaModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "NagaAI", url }));

  const data = await tryFetchJson<NagaModel[] | { data: NagaModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  // /v1/models returns the full multi-vendor catalog; the key only serves the
  // ":free"-suffixed entries. Everything else is paid and must not be exposed as free.
  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const freeModels = list
    .map((m) => m.id)
    .filter((id) => id.endsWith(":free"));
  return { models: freeModels, maxOutputByModel: new Map() };
}
