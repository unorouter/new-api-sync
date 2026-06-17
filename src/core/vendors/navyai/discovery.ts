import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface NavyModel {
  id: string;
  endpoint?: string | null;
  premium?: boolean;
  context_window?: number | null;
  max_output_tokens?: number | null;
}

// NavyAI (api.navy/v1) is a freemium aggregator: `premium: true` models are paid-
// plan only (402 on the free tier), so keep only premium===false. Also restrict to
// the chat-completions endpoint (skip image/audio/embedding rows we route elsewhere).
export async function discoverNavyAiModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "NavyAI", url }));

  const data = await tryFetchJson<NavyModel[] | { data: NavyModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  for (const m of list) {
    if (m.premium === true) continue;
    const ep = m.endpoint ?? "/v1/chat/completions";
    if (!ep.includes("chat/completions")) continue;
    models.push(m.id);
    const cap = m.max_output_tokens;
    if (typeof cap === "number" && cap > 0) maxOutputByModel.set(m.id, cap);
  }
  return { models, maxOutputByModel };
}
