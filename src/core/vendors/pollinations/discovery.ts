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

// Models that cost Pollen credits (premium) rather than running on the free Seed
// tier. The probe also drops PAYMENT_REQUIRED models, but excluding them up front
// avoids wasted test calls. Set drifts in beta; the probe is the backstop.
const PAID_MODELS = new Set([
  "gpt-5.5",
  "openai-audio-large",
  "midijourney-large",
  "perplexity-reasoning",
  "kimi-k2.6",
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
    if (!m.id || PAID_MODELS.has(m.id)) continue;
    models.push(m.id);
    if (typeof m.context_length === "number" && m.context_length > 0)
      maxOutputByModel.set(m.id, m.context_length);
  }
  return { models, maxOutputByModel };
}
