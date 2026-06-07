import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface AiHordeModel {
  id: string;
  clean_name?: string;
  size?: number;
  worker_threads?: number;
}
interface AiHordeModelList {
  data: AiHordeModel[];
}

// AI Horde is volunteer-hosted + slow at anonymous queue priority (multi-second
// latency). Only models with real worker capacity are worth exposing, so gate on a
// minimum worker_threads AND a curated name list (the well-known RP finetunes). Both
// must hold; the probe is the final backstop.
const MIN_WORKER_THREADS = 6;
const ALLOWED_PATTERNS = ["cydonia", "skyfall"];

function isAllowed(m: AiHordeModel): boolean {
  if ((m.worker_threads ?? 0) < MIN_WORKER_THREADS) return false;
  const lower = m.id.toLowerCase();
  return ALLOWED_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Discover curated RP/creative models from AI Horde's OpenAI-compatible proxy
 * (oai.aihorde.net/v1). Anonymous key (0000000000) works at lowest queue priority.
 * Model ids are backend/org/model; bare-name resolution exposes the last segment.
 * Text-only; volunteer-hosted so slow + intermittently available.
 */
export async function discoverAiHordeModels(
  baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "AI Horde", url }));

  const data = await tryFetchJson<AiHordeModelList>(url, {
    headers: { "Content-Type": "application/json" },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (!m.id || !isAllowed(m)) continue;
    models.push(m.id);
  }
  return { models, maxOutputByModel: new Map() };
}
