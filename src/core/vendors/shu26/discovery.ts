import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// shu26.cfd (fronts codegoai.com) - serves deepseek-v4-flash at zero cost on an empty wallet, and
// the model self-reports DeepSeek / deepseek-chat. Its /v1/models answers 200 with an EMPTY data
// array, so there is nothing to enumerate: the two ids that actually answer are listed here and
// the config block still gates them through enabledModels.
const SERVED = ["deepseek-v4-flash-0731", "deepseek-v4-flash"] as const;

export async function discoverShu26Models(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "Shu26",
      url: "static (empty /v1/models)",
    }),
  );
  return { models: [...SERVED], maxOutputByModel: new Map() };
}
