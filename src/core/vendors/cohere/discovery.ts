import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CohereModel {
  id: string;
}
interface CohereModelList {
  data: CohereModel[];
}

// Cohere's OpenAI-compatibility layer (api.cohere.ai/compatibility/v1) serves chat
// + text embeddings in OpenAI shape. Reranker uses a non-OpenAI /v1/rerank body,
// transcribe is Cohere-native, and *-image embeds need image input the text probe
// can't supply, so all three are dropped; the helper handles the rest.
function isExposable(id: string): boolean {
  const m = id.toLowerCase();
  if (m.startsWith("rerank-")) return false;
  if (m.includes("transcribe")) return false;
  if (m.includes("embed") && m.endsWith("-image")) return false;
  return true;
}

function isEmbedding(id: string): boolean {
  return id.toLowerCase().includes("embed");
}

// Cohere enforces a hard per-model output cap that is NOT published in /v1/models
// (context_length is the total window, unrelated: aya has a 128k window but a 4096
// output cap). Sending max_tokens above it 400s the request at the param level,
// before generation, so every reply through that model fails. We learn the real
// cap by overshooting once and parsing the error ("max tokens must be less than or
// equal to N"), then forward it as metadata so the gateway caps requests correctly.
const OVERSHOOT = 200_000;
const CAP_REGEX = /less than or equal to (\d+)/i;

async function probeOutputCap(
  base: string,
  apiKey: string,
  model: string,
): Promise<number | undefined> {
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: OVERSHOOT,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return undefined; // no cap below the overshoot
    const body = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    const match = body?.message?.match(CAP_REGEX);
    const cap = match?.[1] ? Number(match[1]) : undefined;
    return typeof cap === "number" && cap > 0 ? cap : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discover chat + text-embedding models from Cohere's OpenAI-compatibility
 * endpoint. Trial keys serve every listed model free (rate-limited). Embedding
 * ids contain "embed" so inferModelType routes them to /v1/embeddings. Chat
 * models are probed for their hidden output cap (see probeOutputCap).
 */
export async function discoverCohereModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Cohere", url }));

  const data = await tryFetchJson<CohereModelList>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const models: string[] = [];
  for (const m of data?.data ?? []) {
    if (!m.id || !isExposable(m.id)) continue;
    models.push(m.id);
  }

  // Probe output caps for chat models only (embeddings have no max_tokens). Serial
  // to respect the trial key's 20 req/min limit.
  const maxOutputByModel = new Map<string, number>();
  for (const id of models) {
    if (isEmbedding(id)) continue;
    const cap = await probeOutputCap(base, apiKey, id);
    if (cap !== undefined) maxOutputByModel.set(id, cap);
  }

  return { models, maxOutputByModel };
}
