import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface TokenReplyModel {
  id: string;
}

// TokenReply (tokenreply.com/v1) serves a 130+ mixed free+paid catalog. The free
// lane is the "-free" suffix subset (~8: deepseek-v4-flash, big-pickle, mimo-v2.5,
// nemotron-3-ultra + their -thinking variants), reselling the OpenCode-Zen free
// backend but with higher rate limits. "-free" calls cost $0 (verified: balance
// unmoved). Filter to "-free"; the probe drops any id that won't serve.

export async function discoverTokenReplyModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "TokenReply", url }));

  const data = await tryFetchJson<
    TokenReplyModel[] | { data: TokenReplyModel[] }
  >(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const free = list.map((m) => m.id).filter((id) => /-free$/i.test(id));
  return { models: free, maxOutputByModel: new Map() };
}
