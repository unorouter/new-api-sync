import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ZanityModel {
  id: string;
  access?: { free?: boolean };
}

// Zanity (api.zanity.xyz/v1) - RP-focused multi-vendor gateway. Free tier 100K tok/day,
// 500 req/day, no card. ~27 free models (access.free): llama family, deepseek-r1/v3.1,
// mistral, flux, bge embeddings, whisper, elevenlabs TTS + house RP (zanity-rp-large,
// grok-fun). Filter to access.free; the probe drops flaky (zanity-rp-large) + grok-fun
// leaks a GLM template so it's low quality but serves. Authentic on the real opens.
export async function discoverZanityModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Zanity", url }));

  const data = await tryFetchJson<ZanityModel[] | { data: ZanityModel[] }>(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 15_000,
    },
  );

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const models = list.filter((m) => m.access?.free === true).map((m) => m.id);
  return { models, maxOutputByModel: new Map() };
}
