import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface MorphModel {
  id: string;
}

// Morph (api.morphllm.com/v1) - YC coding-agent inference. Free tier renews 200 requests/MONTH
// no card. Expose only the general CHAT models (morph-qwen/minimax/glm/dsv4flash + bare
// deepseek); skip the code-tooling ids (fast-apply/warp-grep/compactor/auto/computer-use) which
// aren't chat. The morph- prefixed ids collapse to canonical names via config modelMapping.
const TOOLING = [
  "apply",
  "grep",
  "compactor",
  "auto",
  "v3-fast",
  "v3-large",
  "warp",
  "computer-use",
];

export async function discoverMorphModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Morph", url }));

  const data = await tryFetchJson<{ data: MorphModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const chat = (data?.data ?? [])
    .map((m) => m.id)
    .filter((id) => id && !TOOLING.some((k) => id.includes(k)));
  return { models: chat, maxOutputByModel: new Map() };
}
