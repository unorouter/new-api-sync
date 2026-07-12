import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// Vivgrid (api.vivgrid.com/v1) - free promo key, but a FAKE-MODEL relay: every premium id
// (claude-opus-4-8, gemini-2.5-pro, claude-sonnet-5, deepseek-v4-pro) is silently served as
// deepseek-v4-flash. Only deepseek-v4-flash is honest. Expose ONLY that one id; the authenticity
// probe would blacklist the claude/gemini tiers anyway. Hardcoded so the fake ids never leak in.
const HONEST = ["deepseek-v4-flash"];

export async function discoverVivgridModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "Vivgrid",
      url: "(deepseek-v4-flash only)",
    }),
  );
  return { models: HONEST, maxOutputByModel: new Map() };
}
