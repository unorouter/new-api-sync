import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface GeminiModel {
  name: string;
  outputTokenLimit?: number;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}
interface GeminiModelList {
  models: GeminiModel[];
}

/**
 * Discover Gemini models from the NATIVE /v1beta/models endpoint (richer metadata
 * than the OpenAI-compat list). Keeps only generateContent models, strips the
 * "models/" prefix so ids match the OpenAI-compat chat surface.
 *
 * `baseUrl` is the OpenAI-compat base (".../v1beta/openai"); the native list lives
 * one level up at ".../v1beta/models".
 */
export async function discoverGeminiModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const nativeBase = baseUrl.replace(/\/$/, "").replace(/\/openai$/, "");
  const url = `${nativeBase}/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: t("CORE.PROVIDER.LABEL_GEMINI"),
      url,
    }),
  );

  const data = await tryFetchJson<GeminiModelList>(url, {
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data?.models ?? []) {
    if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
    const id = m.name.replace(/^models\//, "");
    models.push(id);
    if (typeof m.outputTokenLimit === "number" && m.outputTokenLimit > 0)
      maxOutputByModel.set(id, m.outputTokenLimit);
  }
  return { models, maxOutputByModel };
}
