import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface GithubModel {
  id: string;
  rate_limit_tier?: string;
  supported_output_modalities?: string[];
  limits?: { max_input_tokens?: number; max_output_tokens?: number };
}

// Only low/high rate-limit tiers are usable on the free tier; "custom" (gpt-5,
// o-series, deepseek-r1) is premium and 429s immediately for a free PAT.
const FREE_TIERS = new Set(["low", "high"]);

/**
 * Discover GitHub Models text models from the REST catalog. The catalog lives at
 * ".../catalog/models" (NOT under "/inference"), so it is derived by stripping
 * "/inference" off the OpenAI-compat base. Model ids ("publisher/model") are used
 * verbatim on the chat surface. Keeps free-tier text models + embedding models
 * (text-embedding-3-*, free); premium chat (custom-tier) is dropped.
 */
export async function discoverGithubModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const catalogBase = baseUrl.replace(/\/$/, "").replace(/\/inference$/, "");
  const url = `${catalogBase}/catalog/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "GitHub", url }));

  const data = await tryFetchJson<GithubModel[]>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of data ?? []) {
    if (!m.id) continue;
    const out = m.supported_output_modalities ?? [];
    const isEmbedding = out.includes("embeddings");
    // Free chat (low/high tier + text out) OR any embedding model (all free).
    const isFreeChat =
      out.includes("text") && FREE_TIERS.has(m.rate_limit_tier ?? "");
    if (!isEmbedding && !isFreeChat) continue;
    models.push(m.id);
    const maxOut = m.limits?.max_output_tokens ?? m.limits?.max_input_tokens;
    if (typeof maxOut === "number" && maxOut > 0)
      maxOutputByModel.set(m.id, maxOut);
  }
  return { models, maxOutputByModel };
}
