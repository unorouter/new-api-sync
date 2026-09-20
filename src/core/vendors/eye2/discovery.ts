import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface Eye2Model {
  id: string;
}
interface Eye2ModelList {
  data: Eye2Model[];
}

// eye2.ai reverse (our own Bun proxy, keyless: no account, no cookie). The proxy
// publishes only the families that actually answer, so nothing needs filtering
// here. Ids carry the eye2- prefix because upstream reveals the family and never
// the version, and claiming a version we cannot verify would be a catalog lie.
export async function discoverEye2Models(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "eye2", url }));

  const data = await tryFetchJson<Eye2ModelList>(url, {
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
