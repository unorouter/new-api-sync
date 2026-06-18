// Curated metadata fallback for models NO upstream source carries (releaseDate
// comes only from OpenRouter; models it never listed stay dateless forever).
// Hand-filled from each model's official announcement / model card. Same field
// shape as OpenRouter (SourceMetadata). Lowest priority: only fills gaps the
// live sources leave blank. Keyed by BARE model name (toBareName), so a
// `{model}:free` published name inherits it like any other source.

import { buildFuzzyIndex } from "@core/catalog/metadata";
import {
  type BaseModelPricing,
  type PricingSource,
  type SourceMetadata,
} from "./types";

const iso = (d: string) => `${d}T00:00:00.000Z`;

// bare name -> curated metadata. Dates are official announcement dates.
const CURATED: Record<string, SourceMetadata> = {
  // Anthropic (OpenRouter dropped the dated 3.7 id)
  "claude-3-7-sonnet-20250219": { releaseDate: iso("2025-02-24") },
  // Mistral
  "mistral-7b-instruct-v0.3": { releaseDate: iso("2024-05-22") },
  "pixtral-12b-2409": { releaseDate: iso("2024-09-17") },
  // Qwen
  "qwq-32b": { releaseDate: iso("2025-03-05") },
  // DeepSeek distill
  "deepseek-r1-distill-qwen-32b": { releaseDate: iso("2025-01-20") },
  // Google
  "gemma-2-2b-it": { releaseDate: iso("2024-07-31") },
  "gemma-3n-e2b-it": { releaseDate: iso("2025-06-26") },
  // Microsoft
  "phi-4-reasoning": { releaseDate: iso("2025-04-30") },
  "phi-4-mini-reasoning": { releaseDate: iso("2025-04-30") },
  // NVIDIA
  "nemotron-mini-4b-instruct": { releaseDate: iso("2024-09-03") },
  // Liquid AI
  "lfm-2.5-1.2b-instruct": { releaseDate: iso("2026-01-19") },
  "lfm-2.5-1.2b-thinking": { releaseDate: iso("2026-01-19") },
  // H Company
  "holo2-30b-a3b": { releaseDate: iso("2025-11-14") },
  // SDAIA
  "allam-2-7b": { releaseDate: iso("2024-09-11") },
  // TheDrummer (v4.3 has no public date; v4.1 shipped 2025-09-27)
  "cydonia-24b-v4.3": { releaseDate: iso("2025-09-27") },
  // Groq agentic system (GA on GroqCloud)
  compound: { releaseDate: iso("2025-09-04") },
  "compound-mini": { releaseDate: iso("2025-09-04") },
};

export function buildCuratedSource(): PricingSource {
  return {
    name: "curated",
    pricing: buildFuzzyIndex(new Map<string, BaseModelPricing>()),
    metadata: buildFuzzyIndex(new Map(Object.entries(CURATED))),
  };
}
