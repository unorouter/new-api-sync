import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface BlockRunModel {
  id: string;
  billing_mode?: string;
  context_length?: number;
  max_output_tokens?: number;
}

// BlockRun ClawRouter (blockrun.ai/api/v1). KEYLESS for the free lane (no signup,
// no card). 72-model catalog with a two-tier split: 10 ids carry billing_mode:"free"
// (re-wrapped NVIDIA NIM open models - nemotron, llama-4-maverick, qwen3-next-80b,
// mistral-large-3, step-3.7-flash), the rest hard-gate behind 402 x402 USDC. The
// advertised frontier ids (gpt-5.5/claude-opus) are vaporware marketing behind the
// paywall - never expose them. Filter strictly to billing_mode:"free". Sustainability
// is upstream-dependent (borrowed NVIDIA tier), so treat as an additive free lane;
// the probe drops any free id the gateway stops serving.
export async function discoverBlockRunModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "BlockRun", url }));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey && apiKey !== "keyless")
    headers.Authorization = `Bearer ${apiKey}`;

  const data = await tryFetchJson<{ data?: BlockRunModel[] }>(url, {
    headers,
    timeoutMs: 15_000,
  });

  const free = (data?.data ?? []).filter((m) => m.billing_mode === "free");
  const maxOutputByModel = new Map<string, number>();
  for (const m of free) {
    const out = m.max_output_tokens ?? m.context_length;
    if (out) maxOutputByModel.set(m.id, out);
  }
  return { models: free.map((m) => m.id), maxOutputByModel };
}
