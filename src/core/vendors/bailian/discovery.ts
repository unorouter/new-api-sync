import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface BailianModel {
  id: string;
}

// Alibaba Bailian / Model Studio (Singapore intl, ws-*.ap-southeast-1.maas.aliyuncs.com
// /compatible-mode). First-party host for real Qwen3.x / DeepSeek-V4 / GLM-5.x / Kimi-K2.x.
// Free tier = 1M tokens per model, Stop-on-Exhaust enabled account-side -> 403
// AllocationQuota.FreeTierOnly at exhaustion, never bills. /compatible-mode/v1/models lists
// ~148 models; the shared runner splits by inferModelType and probes each as itself
// (text -> chat, embedding -> /embeddings). Keep text chat, VL/omni multimodal chat, and
// text-embedding-v3/v4. Drop what the OpenAI-compat chat/embedding probe cannot serve:
// realtime/streaming audio (asr/tts/s2s/realtime/omni-realtime/vc/vd), the qwen-mt
// translation endpoint, tingwu, and the qwen-image/wan/z-image generation models (DashScope
// async image path, not OpenAI /images/generations - a separate integration).
const UNSERVABLE =
  /realtime|-asr|-s2s|-tts|-mt-|livetranslate|tingwu|-vc-|-vd-|-image|qwen-image|^wan|z-image/i;

export async function discoverBailianModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Bailian", url }));

  const data = await tryFetchJson<BailianModel[] | { data: BailianModel[] }>(
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
  const models = list
    .map((m) => m.id)
    .filter((id) => id && !UNSERVABLE.test(id));
  return { models, maxOutputByModel: new Map() };
}
