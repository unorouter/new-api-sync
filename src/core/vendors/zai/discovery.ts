import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// Z.ai's /models endpoint lists only the paid GLM line (glm-4.5/4.6/4.7/5/5.1),
// which 1113 "insufficient balance" without a package. The genuinely-free tier is
// the flash variants, which are NOT enumerated by /models, so the free set is
// curated here. Override per-deployment with providerConfig.models.
const FREE_FLASH_MODELS = ["glm-4.5-flash", "glm-4.7-flash"];

export async function discoverZaiModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERED_MODELS", {
      name: "Z.ai",
      count: FREE_FLASH_MODELS.length,
    }),
  );
  return { models: [...FREE_FLASH_MODELS], maxOutputByModel: new Map() };
}
