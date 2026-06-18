import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface MegaNovaModel {
  id: string;
}

// MegaNova (api.meganova.ai/v1) is an RP-focused gateway (Character Studio). 105 models;
// a free-quota subset serves at $0 (RP finetunes: Nevoria, Stheno, Euryale, Sapphira,
// Violet-Lotus + Mistral-Small + manta house), the rest (DeepSeek/GLM/claude/gemini) are
// credit-gated ("Insufficient credits"). Expose all CHAT models (drop image/video/audio/
// embed/rerank) and let the probe drop the credit-gated ones. Daily-reset free quota.
const NONTEXT =
  /seedream|seedance|whisper|embedding|reranker|bge-|t2i|i2v|t2v|image|video|audio|tts|stt|ocr/i;

export async function discoverMegaNovaModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "MegaNova", url }));

  const data = await tryFetchJson<
    MegaNovaModel[] | { data: MegaNovaModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const models = list.map((m) => m.id).filter((id) => !NONTEXT.test(id));
  return { models, maxOutputByModel: new Map() };
}
