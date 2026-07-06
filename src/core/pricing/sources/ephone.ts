import { buildFuzzyIndex } from "@core/catalog/metadata";
import { tryFetchJson } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";

import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
} from "./types";

// ePhone (VoAPI-style fork) serves rich per-model metadata in /api/pricing's
// data.model_info array: English description, knowledge cutoff, release date,
// context/output limits, modalities, and capability flags. We already hit this
// endpoint for the ephone PROVIDER (pricing); this source reuses the same shape
// as a METADATA fallback for the whole catalog (fills gaps openrouter/basellm
// leave, e.g. Chinese-vendor video/audio + fresh flagships ePhone catalogs early).
const EPHONE_PRICING_URL = "https://api.ephone.ai/api/pricing";

interface EphoneModelInfo {
  model_name?: string;
  description?: string;
  description_en?: string;
  knowledge?: number;
  release_date?: number;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
}

interface EphonePricingResponse {
  data?: { model_info?: EphoneModelInfo[] };
}

// Unix seconds -> ISO date (midnight UTC), matching curated iso().
function tsToIso(sec: number | undefined): string | undefined {
  if (!sec || sec <= 0) return undefined;
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

function toMetadata(m: EphoneModelInfo): SourceMetadata {
  const md: SourceMetadata = {};
  const desc = m.description_en || m.description;
  if (desc) md.description = desc.trim();
  const release = tsToIso(m.release_date);
  if (release) md.releaseDate = release;
  const cutoff = tsToIso(m.knowledge);
  if (cutoff) md.knowledgeCutoff = cutoff;
  if (typeof m.limit?.context === "number" && m.limit.context > 0)
    md.contextWindow = m.limit.context;
  if (typeof m.limit?.output === "number" && m.limit.output > 0)
    md.maxOutputTokens = m.limit.output;
  const inputs = m.modalities?.input ?? [];
  if (inputs.includes("image")) md.supportsVision = true;
  if (inputs.includes("audio")) md.supportsAudio = true;
  if (m.attachment) md.supportsPdf = true;
  if (m.reasoning) md.isReasoning = true;
  if (m.tool_call) md.supportsTools = true;
  return md;
}

export async function fetchEphoneMetadataSource(): Promise<PricingSource | null> {
  const raw = await tryFetchJson<EphonePricingResponse>(EPHONE_PRICING_URL, {
    timeoutMs: 20_000,
  }).catch(() => null);
  const list = raw?.data?.model_info;
  if (!Array.isArray(list) || list.length === 0) {
    consola.warn(t("CORE.METADATA.OPENROUTER_FETCH_FAILED"));
    return null;
  }

  const metadataMap = new Map<string, SourceMetadata>();
  for (const m of list) {
    if (!m.model_name) continue;
    const md = toMetadata(m);
    if (Object.keys(md).length === 0) continue;
    if (!metadataMap.has(m.model_name)) metadataMap.set(m.model_name, md);
  }
  consola.info(t("CORE.METADATA.OPENROUTER_FETCHED", { count: metadataMap.size }));

  return {
    name: "ephone",
    pricing: buildFuzzyIndex(new Map<string, BaseModelPricing>()),
    metadata: buildFuzzyIndex(metadataMap),
  };
}
