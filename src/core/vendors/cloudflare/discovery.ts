import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CloudflareModelProperty {
  property_id: string;
  value: unknown;
}
interface CloudflareModel {
  name: string;
  properties?: CloudflareModelProperty[];
}
interface CloudflareModelSearch {
  result?: CloudflareModel[];
  success?: boolean;
}

/**
 * Discover Workers AI text models from the REST catalog. Cloudflare has no
 * OpenAI-style /v1/models list; the catalog lives at ".../ai/models/search"
 * (sibling of the OpenAI-compat chat surface ".../ai/v1/chat/completions") and is
 * filtered by the "Text Generation" task. baseUrl is the ".../ai" root (the
 * runner appends /v1/chat/completions); we append /models/search here. Model ids
 * ("@cf/meta/...") are used verbatim on the chat surface. context_window is the
 * only size the catalog exposes, so it doubles as the output ceiling (a
 * max_tokens above it 400s upstream).
 */
export async function discoverCloudflareModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const searchBase = baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const fetchTask = (task: string) => {
    const url = `${searchBase}/models/search?task=${task}&per_page=100`;
    consola.info(
      t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Cloudflare", url }),
    );
    return tryFetchJson<CloudflareModelSearch>(url, {
      headers,
      timeoutMs: 15_000,
    });
  };

  const [textGen, embeddings] = await Promise.all([
    fetchTask("Text+Generation"),
    fetchTask("Text+Embeddings"),
  ]);

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of [...(textGen?.result ?? []), ...(embeddings?.result ?? [])]) {
    if (!m.name) continue;
    models.push(m.name);
    const ctx = m.properties?.find((p) => p.property_id === "context_window");
    const ctxValue =
      typeof ctx?.value === "string"
        ? Number.parseInt(ctx.value, 10)
        : typeof ctx?.value === "number"
          ? ctx.value
          : Number.NaN;
    if (Number.isFinite(ctxValue) && ctxValue > 0)
      maxOutputByModel.set(m.name, ctxValue);
  }
  return { models, maxOutputByModel };
}
