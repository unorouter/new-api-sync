import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface XkiroModel {
  id: string;
  access_tier?: string;
  max_output_tokens?: number;
  context_length?: number;
}

// xKiro (xkiro.com/v1) - OpenAI-compat aggregator, GitHub signup. Three tiers in one
// catalog: "free" (no wallet needed), "premium" and "paid" both refuse without a
// deposited balance, so only access_tier "free" is kept. The free tier is ONE budget of
// 500k tokens a day across every free model (GET /v1/usage reports used_today), which is
// why the config allowlist keeps a handful of flagships rather than all 37.
// vendor/model slugs bare-collapse via the normalizer; ids already carrying :free keep it,
// the rest gain it from the zero-ratio rule.
export async function discoverXkiroModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "xKiro", url }));

  const data = await tryFetchJson<{ data?: XkiroModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const free = (data?.data ?? []).filter((m) => m.access_tier === "free");
  const maxOutputByModel = new Map<string, number>();
  for (const m of free)
    if (m.max_output_tokens) maxOutputByModel.set(m.id, m.max_output_tokens);
  return { models: free.map((m) => m.id), maxOutputByModel };
}
