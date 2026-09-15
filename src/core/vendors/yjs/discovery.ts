import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface YjsPricing {
  group_ratio?: Record<string, number>;
  data?: { model_name: string; enable_groups?: string[] }[];
}

// api.yjs.im - relay whose catalog spans paid and free groups, so /v1/models (84 entries,
// claude and gpt included) is NOT the free list. /api/pricing carries group_ratio, and a
// group priced 0 is the free tier ("Unlimited", 17 models: kimi-k3, deepseek-v4-flash,
// glm-5.3-flash, the nemotrons, laguna, north-mini-code). Reading the ratio rather than the
// group name means a renamed or added free group is picked up on its own. The key is
// cross-group with auto ratio, so those models bill at 0; everything else is left alone.
export async function discoverYjsModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/api/pricing`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "yjs", url }));

  const data = await tryFetchJson<YjsPricing>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const freeGroups = new Set(
    Object.entries(data?.group_ratio ?? {})
      .filter(([, ratio]) => ratio === 0)
      .map(([group]) => group),
  );
  const models = (data?.data ?? [])
    .filter((m) => (m.enable_groups ?? []).some((g) => freeGroups.has(g)))
    .map((m) => m.model_name);
  return { models, maxOutputByModel: new Map() };
}
