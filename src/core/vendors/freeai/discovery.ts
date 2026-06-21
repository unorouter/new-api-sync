import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// free.ai (api.free.ai/v1). KEYLESS, self-hosted open-source project on a single
// droplet. CRITICAL: its /v1/models is a DECORATIVE 386-entry OpenRouter mirror full
// of fictional ids (claude-opus-4.8, gpt-5.5-pro) that ALL 404 - only one model is
// actually loaded. So discovery is static: hardcode the real HF id. The probe drops
// it when the droplet churns (IP rotates, image/TTS endpoints overload). Single
// honest Qwen2.5-VL-7B (vision), no frontier spoof.
const FREE_AI_MODEL = "Qwen/Qwen2.5-VL-7B-Instruct-AWQ";

export async function discoverFreeAiModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "free.ai",
      url: `${FREE_AI_MODEL} (static; /v1/models is a fake catalog)`,
    }),
  );
  return { models: [FREE_AI_MODEL], maxOutputByModel: new Map() };
}
