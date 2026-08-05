import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface GrokModel {
  id: string;
}
interface GrokModelList {
  data: GrokModel[];
}

// grok.com web reverse (chenyme/grok2api). The proxy resolves each account's
// live entitlement and only advertises what it can actually serve, so the
// listing is authoritative - a free account gets grok-chat-fast plus
// grok-imagine-image-lite and nothing else, even though /rest/rate-limits
// upstream reports a quota for the paid expert tier.
export async function discoverGrokModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Grok", url }));

  const data = await tryFetchJson<GrokModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (m.id) models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
