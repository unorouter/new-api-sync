import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface MimoModel {
  id: string;
}

// Xiaomi MiMo (api.xiaomimimo.com/v1) - first-party MiMo-V2.5 models. Prepaid balance
// (small top-up + bonus credits), hard-stops at $0, no auto-recharge. chat: mimo-v2.5,
// mimo-v2.5-pro; audio: -asr (STT) + -tts x3. Only chat is emitted (audioChannelType
// omitted) to conserve the small balance. OpenAI-compat, tool-calling verified.
export async function discoverMimoModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Xiaomi MiMo", url }));

  const data = await tryFetchJson<MimoModel[] | { data: MimoModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
