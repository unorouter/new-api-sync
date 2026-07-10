import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface TyphoonModel {
  id: string;
}

// Typhoon (api.opentyphoon.ai/v1) - SCB 10X's Thai-first LLM (Thailand). Free tier: RPS/RPM
// rate-limited, NO card (429 on limit -> acceptRateLimited absorbs). Chat model typhoon-v2.5-30b
// (Thai + SEA multilingual, unique niche). OCR/ASR endpoints are non-chat -> skipped.
const SKIP = /ocr|asr|whisper|embed|tts/i;

export async function discoverTyphoonModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Typhoon", url }));

  // /v1/models returns a bare array (not {data:[...]}).
  const data = await tryFetchJson<TyphoonModel[] | { data: TyphoonModel[] }>(
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
  const chat = list.filter((m) => !SKIP.test(m.id));
  return { models: chat.map((m) => m.id), maxOutputByModel: new Map() };
}
