import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface PollinationsModel {
  id: string;
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
}
interface PollinationsModelList {
  data: PollinationsModel[];
}

// Allowlist of genuinely-free models. Pollinations is per-token Pollen-metered on
// gen.pollinations.ai; only the anonymous/Seed-tier open models cost ~0 and run on
// the free daily grant. The legacy /models tier field currently confirms only
// openai-fast (gpt-oss-20b) as anonymous-tier free; the rest (gpt-5, grok, glm,
// image) drain the grant and 402. Keep this tight to avoid 402-prone channels;
// add a model here only after confirming it costs ~0/token.
const FREE_MODELS = new Set([
  "openai-fast", // gpt-oss-20b, anonymous tier
]);

/**
 * Discover free-tier models from Pollinations' unified OpenAI-compatible endpoint
 * (gen.pollinations.ai/v1/models). baseUrl is the host; the runner appends /v1.
 * Premium Pollen-billed models are filtered out so only Seed-tier free models are
 * emitted.
 */
export async function discoverPollinationsModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Pollinations", url }),
  );

  const data = await tryFetchJson<PollinationsModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data?.data ?? []) {
    if (!m.id || !FREE_MODELS.has(m.id)) continue;
    models.push(m.id);
    if (typeof m.context_length === "number" && m.context_length > 0)
      maxOutputByModel.set(m.id, m.context_length);
  }
  return { models, maxOutputByModel };
}
