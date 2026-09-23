import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface KiloModel {
  id: string;
  context_length?: number;
  context_window?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { output_modalities?: string[] };
}

// Stealth previews are $0 without the :free suffix (stealth/space-bunny-alpha)
// and serve keyless too; the */free ids are routers, not models.
function isFreeChatModel(m: KiloModel): boolean {
  if (/:free$/.test(m.id)) return true;
  const out = m.architecture?.output_modalities;
  return (
    m.pricing?.prompt === "0" &&
    m.pricing?.completion === "0" &&
    out?.length === 1 &&
    out[0] === "text" &&
    !m.id.endsWith("/free")
  );
}

// Kilo Code AI Gateway (api.kilo.ai/api/gateway). Base is the gateway root; new-api +
// runner append /v1/chat/completions for forwarding, but the model list lives at
// /models (NOT /v1/models). Keyless: free :free-tagged models serve unauthenticated
// (200 req/hr per IP). ~9 free models (nemotron-3-ultra/super, step-3.7-flash,
// nex-n2-pro, cohere/north-mini-code, poolside/laguna).
export async function discoverKiloModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Kilo Code", url }));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey && apiKey !== "keyless")
    headers.Authorization = `Bearer ${apiKey}`;

  const data = await tryFetchJson<{ data?: KiloModel[] }>(url, {
    headers,
    timeoutMs: 15_000,
  });

  const list = data?.data ?? [];
  const free = list.filter(isFreeChatModel);
  const maxOutputByModel = new Map<string, number>();
  for (const m of free) {
    const ctx = m.context_length ?? m.context_window;
    if (ctx) maxOutputByModel.set(m.id, ctx);
  }
  return { models: free.map((m) => m.id), maxOutputByModel };
}
