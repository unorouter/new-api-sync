import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface UnturfModel {
  id: string;
}
interface UnturfModelList {
  data: UnturfModel[];
}

// hermes.ai.unturf.com (UncloseAI). Keyless in the plainest way of any lane here:
// native OpenAI shape, real messages array, and it answers with no Authorization
// header at all. Measured 2026-09-21: exactly ONE concurrent request, a second
// one gets an instant 429, and a single completion takes about 10s. So this is a
// small, steady lane, not a bulk one, and perUpstreamConcurrency must stay at 1.
export async function discoverUnturfModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "UncloseAI", url }));

  const data = await tryFetchJson<UnturfModelList>(url, {
    headers: {
      ...(apiKey && apiKey !== "keyless"
        ? { Authorization: `Bearer ${apiKey}` }
        : {}),
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
