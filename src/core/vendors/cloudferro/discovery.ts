import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CloudFerroModel {
  id: string;
}

// CloudFerro Sherlock (api-sherlock.cloudferro.com/openai/v1) - EU/GDPR-hosted (Poland),
// "Zero Logos, Full Privacy". 14 models: Llama-3.3-70B, DeepSeek-R1-Distill-70B,
// Mistral-Small-4-119B, gpt-oss-120b, MiniMax-M2.5, gemma-4 (chat), Polish PLLuM/Bielik,
// e5/bge/stella (embeddings). Vendor-namespaced ids (bare-name strips). Free-trial credits
// on the CloudFerro Cloud wallet, hard-stops when drained. OpenAI-compat, tool-calling
// verified. Base includes the /openai path; the runner + discovery append /v1.
export async function discoverCloudFerroModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "CloudFerro Sherlock", url }),
  );

  const data = await tryFetchJson<
    CloudFerroModel[] | { data: CloudFerroModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
