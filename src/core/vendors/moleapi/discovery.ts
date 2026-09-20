import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface MoleapiModel {
  id: string;
}

// api.moleapi.com - new-api relay with a 527-model catalog carrying a genuine small-model free
// tier: nine ids answer with the wallet untouched (quota 24865 before and after), and they
// self-report correctly (glm-4.7-flash-free says Z.ai). All are models the fleet already sells,
// so the lane is failover capacity. Base is root; discovery appends /v1.
export async function discoverMoleapiModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Moleapi", url }));

  const data = await tryFetchJson<MoleapiModel[] | { data: MoleapiModel[] }>(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 15_000,
    },
  );

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
