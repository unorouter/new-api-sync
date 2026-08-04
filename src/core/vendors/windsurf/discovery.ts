import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface WindsurfModel {
  id: string;
}
interface WindsurfModelList {
  data: WindsurfModel[];
}

// Windsurf/Devin reverse. Since v3.9.8 the proxy filters /v1/models against the
// account's live rate table, so what it advertises is what the account is
// actually entitled to rather than the static 130-model catalog.
export async function discoverWindsurfModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Windsurf", url }));

  const data = await tryFetchJson<WindsurfModelList>(url, {
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
