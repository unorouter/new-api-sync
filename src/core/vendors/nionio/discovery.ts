import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface NionioModel {
  id: string;
}

// api.nionio2026.xyz - new-api relay whose "[free]" group serves GLM-5.3, deepseek-v4-pro
// and kimi-k3 at zero cost on an empty wallet (verified by balance delta: the call returns
// 200 and the quota does not move). Free lanes proxy shared upstream pools, so a busy pool
// returns a passthrough 429 rather than a key quota: concurrency stays 1 and 429s are accepted.
// Cloudflare in front of it 403s a default agent, hence the browser User-Agent.
// Base is root; discovery appends /v1.
export async function discoverNionioModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Nionio", url }));

  const data = await tryFetchJson<NionioModel[] | { data: NionioModel[] }>(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      },
      timeoutMs: 15_000,
    },
  );

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
