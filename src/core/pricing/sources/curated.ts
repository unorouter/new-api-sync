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
  "claude-3-7-sonnet-20250219": {
    releaseDate: iso("2025-02-24"),
    contextWindow: 200_000,
  },
  // Mistral
  "mistral-7b-instruct-v0.3": {
    releaseDate: iso("2024-05-22"),
    contextWindow: 32_768,
  },
  "pixtral-12b-2409": {
    releaseDate: iso("2024-09-17"),
    contextWindow: 131_072,
  },
  // Qwen
  "qwq-32b": { releaseDate: iso("2025-03-05"), contextWindow: 131_072 },
  // DeepSeek distill
  "deepseek-r1-distill-qwen-32b": {
    releaseDate: iso("2025-01-20"),
    contextWindow: 131_072,
  },
  // Google
  "gemma-2-2b-it": { releaseDate: iso("2024-07-31"), contextWindow: 8_192 },
  "gemma-3n-e2b-it": {
    releaseDate: iso("2025-06-26"),
    contextWindow: 32_768,
  },
  // Microsoft
  "phi-4-reasoning": {
    releaseDate: iso("2025-04-30"),
    contextWindow: 32_768,
  },
  "phi-4-mini-reasoning": {
    releaseDate: iso("2025-04-30"),
    contextWindow: 131_072,
  },
  // NVIDIA
  "nemotron-mini-4b-instruct": {
    releaseDate: iso("2024-09-03"),
    contextWindow: 4_096,
  },
  // Liquid AI
  "lfm-2.5-1.2b-instruct": {
    releaseDate: iso("2026-01-06"),
    contextWindow: 32_768,
  },
  "lfm-2.5-1.2b-thinking": {
    releaseDate: iso("2026-01-20"),
    contextWindow: 32_768,
  },
  // H Company
  "holo2-30b-a3b": {
    releaseDate: iso("2025-11-10"),
    contextWindow: 131_072,
  },
  // SDAIA
  "allam-2-7b": { releaseDate: iso("2024-09-11"), contextWindow: 4_096 },
  // TheDrummer (HF repo init 2025-11-08)
  "cydonia-24b-v4.3": {
    releaseDate: iso("2025-11-08"),
    contextWindow: 131_072,
  },
  // Groq agentic system (GA on GroqCloud)
  compound: { releaseDate: iso("2025-09-04"), contextWindow: 131_072 },
  "compound-mini": {
    releaseDate: iso("2025-09-04"),
    contextWindow: 131_072,
  },
  // Google (not on OpenRouter under these ids)
  "gemini-3-flash": {
    releaseDate: iso("2025-12-17"),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    series: "Gemini",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "gemma-3-27b-it": {
    releaseDate: iso("2025-03-12"),
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    series: "Gemma",
    supportsVision: true,
    supportsTools: true,
  },
  // OpenAI (the :free GPT-4o variant; original launch caps)
  "gpt-4o": {
    releaseDate: iso("2024-05-13"),
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    series: "GPT",
    supportsVision: true,
    supportsTools: true,
  },
  // Zhipu (GLM-4.5 series launch; Flash shares the date)
  "glm-4.5-flash": {
    releaseDate: iso("2025-07-28"),
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  // NousResearch
  "hermes-3-llama-3.1-8b-fp8-dynamic": {
    releaseDate: iso("2024-08-15"),
    contextWindow: 131_072,
    series: "Hermes",
    supportsTools: true,
  },
  // InternLM Intern-S scientific series
  "intern-s1": {
    releaseDate: iso("2025-07-24"),
    contextWindow: 65_536,
    series: "Intern-S",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "intern-s1-mini": {
    releaseDate: iso("2025-07-24"),
    contextWindow: 65_536,
    series: "Intern-S",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "intern-s1-pro": {
    releaseDate: iso("2026-02-04"),
    contextWindow: 262_144,
    series: "Intern-S",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "intern-s2-preview": {
    releaseDate: iso("2026-05-15"),
    contextWindow: 262_144,
    series: "Intern-S",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // InternVL 3.5 (trained 32K context per HF card; -latest aliases the 241B flagship)
  "internvl3.5-241b-a28b": {
    releaseDate: iso("2025-08-25"),
    contextWindow: 32_768,
    series: "InternVL",
    isReasoning: true,
    supportsVision: true,
  },
  "internvl3.5-latest": {
    releaseDate: iso("2025-08-25"),
    contextWindow: 32_768,
    series: "InternVL",
    isReasoning: true,
    supportsVision: true,
  },
  // Kuaishou/StreamLake KAT-Coder (StreamLake free-availability announcement)
  "kat-coder-air-v1": {
    releaseDate: iso("2025-10-23"),
    contextWindow: 128_000,
    series: "KAT",
    supportsTools: true,
  },
  // NVIDIA Nemotron
  "llama-3.1-nemotron-nano-vl-8b-v1": {
    releaseDate: iso("2025-06-03"),
    contextWindow: 16_384,
    series: "Llama",
    supportsVision: true,
    supportsTools: true,
  },
  "nemotron-3-nano-omni-30b-a3b-reasoning": {
    releaseDate: iso("2026-04-28"),
    contextWindow: 262_144,
    series: "Nemotron",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "nemotron-nano-12b-v2-vl": {
    releaseDate: iso("2025-10-28"),
    contextWindow: 131_072,
    series: "Nemotron",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "nemotron-nano-9b-v2": {
    releaseDate: iso("2025-08-18"),
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    series: "Nemotron",
    isReasoning: true,
    supportsTools: true,
  },
  // Alibaba Qwen (qwen3-235b = original base, NOT the 2507 update)
  "qwen3-235b": {
    releaseDate: iso("2025-04-29"),
    contextWindow: 32_768,
    series: "Qwen",
    isReasoning: true,
    supportsTools: true,
  },
  "qwen3-coder-480b-a35b-instruct": {
    releaseDate: iso("2025-07-22"),
    contextWindow: 262_144,
    series: "Qwen",
    supportsTools: true,
  },
  "qwen3guard-gen-0.6b": {
    releaseDate: iso("2025-09-23"),
    contextWindow: 32_768,
    series: "Qwen",
  },
  "qwen3guard-gen-8b": {
    releaseDate: iso("2025-09-23"),
    contextWindow: 32_768,
    series: "Qwen",
  },
  // SenseTime SenseNova (ctx not officially published; flash line ~ 128K)
  "sensenova-6.7-flash-lite": {
    releaseDate: iso("2026-05-08"),
    contextWindow: 131_072,
    series: "SenseNova",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Abacus.AI finetune of Llama 3.1 70B
  "dracarys-llama-3.1-70b-instruct": {
    releaseDate: iso("2024-08-14"),
    contextWindow: 131_072,
    series: "Llama",
  },
  // Mistral Nemo finetune
  "mn-violet-lotus-12b": {
    releaseDate: iso("2024-11-16"),
    contextWindow: 131_072,
    series: "Mistral",
  },
  // Google DiffusionGemma (Gemma 4 discrete-diffusion, MoE 25.2B/3.8B)
  "diffusiongemma-26b-a4b-it": {
    releaseDate: iso("2026-06-10"),
    contextWindow: 262_144,
    series: "Gemma",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // MegaNova Manta (closed; ctx from console, date = family announcement)
  "manta-flash-1.0": {
    releaseDate: iso("2025-10-30"),
    contextWindow: 16_384,
    series: "Manta",
  },
  "manta-mini-1.0": {
    releaseDate: iso("2025-10-30"),
    contextWindow: 8_192,
    series: "Manta",
  },
  // Nex AGI N2 (MoE 397B/17B on Qwen3.5)
  "nex-n2-pro": {
    releaseDate: iso("2026-06-02"),
    contextWindow: 262_144,
    series: "Nex N2",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Cohere North-Mini-Code
  "north-mini-code": {
    releaseDate: iso("2026-06-09"),
    contextWindow: 262_144,
    series: "North",
    isReasoning: true,
    supportsTools: true,
  },
  // Pollinations alias -> GPT-5 Nano (auto-upgrading slug; specs of current target)
  "openai-fast": {
    releaseDate: iso("2025-08-07"),
    contextWindow: 400_000,
    series: "GPT",
    supportsVision: true,
    supportsTools: true,
  },
  // Sao10K Llama-3 roleplay finetunes (native 8K, HF first-commit dates)
  "l3-70b-euryale-v2.1": {
    releaseDate: iso("2024-06-11"),
    contextWindow: 8_192,
    series: "Llama",
  },
  "l3-8b-stheno-v3.2": {
    releaseDate: iso("2024-06-05"),
    contextWindow: 8_192,
    series: "Llama",
  },
  // TheDrummer Skyfall (Mistral-Small-3.2 upscaled to 31B; inherits 128K ctx)
  "skyfall-31b-v4.2": {
    releaseDate: iso("2026-03-01"),
    contextWindow: 131_072,
    series: "Mistral",
  },
  // InternLM rolling aliases (point at the current flagship's specs/date)
  "intern-latest": {
    releaseDate: iso("2025-07-24"),
    contextWindow: 65_536,
    series: "Intern-S",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "internvl-latest": {
    releaseDate: iso("2025-08-25"),
    contextWindow: 32_768,
    series: "InternVL",
    isReasoning: true,
    supportsVision: true,
  },
  // Meta Llama 3.2 vision (our name drops the -instruct OpenRouter uses)
  "llama-3.2-90b-vision": {
    releaseDate: iso("2024-09-25"),
    contextWindow: 131_072,
    series: "Llama",
    supportsVision: true,
    supportsTools: true,
  },
  // Mistral Small (generic :free = Small 3 24B-2501; live ctx wins if present)
  "mistral-small": {
    releaseDate: iso("2025-01-30"),
    contextWindow: 32_768,
    series: "Mistral",
    supportsTools: true,
  },
  "mistral-small-4-119b-2603": {
    releaseDate: iso("2026-03-16"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  // TNG DeepSeek-R1T Chimera merges (R1 + V3-0324; inherit 163840 ctx)
  "deepseek-r1t-chimera": {
    releaseDate: iso("2025-04-27"),
    contextWindow: 163_840,
    series: "DeepSeek",
    isReasoning: true,
    supportsTools: true,
  },
  "deepseek-r1t2-chimera": {
    releaseDate: iso("2025-07-02"),
    contextWindow: 163_840,
    series: "DeepSeek",
    isReasoning: true,
    supportsTools: true,
  },
  // Mistral Devstral 2 (coding; 256K)
  "devstral-2": {
    releaseDate: iso("2025-12-09"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "devstral-2-123b": {
    releaseDate: iso("2025-12-09"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  // Cognitive Computations Dolphin (Mistral-Small-24B base)
  "dolphin-mistral-24b-venice-edition": {
    releaseDate: iso("2025-06-12"),
    contextWindow: 32_768,
    series: "Mistral",
    supportsTools: true,
  },
  // Qwen3 4B thinking (2507 update)
  "qwen3-4b-thinking-2507": {
    releaseDate: iso("2025-08-05"),
    contextWindow: 262_144,
    series: "Qwen",
    isReasoning: true,
    supportsTools: true,
  },
  // Llama-3.3-70B roleplay finetunes (inherit 128K)
  "l3.3-ms-nevoria-70b": {
    releaseDate: iso("2025-01-14"),
    contextWindow: 131_072,
    series: "Llama",
  },
  "sapphira-l3.3-70b-0.1": {
    releaseDate: iso("2025-07-31"),
    contextWindow: 131_072,
    series: "Llama",
  },
  // Qwen coder variants (int4 quant inherits the base 256K; 2.5-coder-3b = 32K)
  "qwen3-coder-480b-a35b-instruct-int4-mixed-ar": {
    releaseDate: iso("2025-07-22"),
    contextWindow: 262_144,
    series: "Qwen",
    supportsTools: true,
  },
  "qwen2.5-coder-3b-instruct": {
    releaseDate: iso("2024-11-06"),
    contextWindow: 32_768,
    series: "Qwen",
    supportsTools: true,
  },

  // ByteDance Doubao Seed 1.6 (FORCE conf launch; 256K, multimodal+reasoning)
  "doubao-seed-1.6": {
    releaseDate: iso("2025-06-11"),
    contextWindow: 262_144,
    series: "Doubao",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "doubao-seed-1.6-thinking": {
    releaseDate: iso("2025-06-11"),
    contextWindow: 262_144,
    series: "Doubao",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "doubao-seed-1.6-flash": {
    releaseDate: iso("2025-06-11"),
    contextWindow: 262_144,
    series: "Doubao",
    supportsVision: true,
    supportsTools: true,
  },

  // ─── Image-gen models (no context window; dates = public release, NOT the
  //     ByteDance YYMMDD snapshot suffix which predates launch) ───
  // ByteDance Doubao (Seed image)
  "doubao-seededit-3": { releaseDate: iso("2025-06-06"), mode: "image" },
  "doubao-seedream-3": { releaseDate: iso("2025-04-16"), mode: "image" },
  "doubao-seedream-4": { releaseDate: iso("2025-09-09"), mode: "image" },
  "doubao-seedream-4.5": { releaseDate: iso("2025-12-04"), mode: "image" },
  "doubao-seedream-5": { releaseDate: iso("2026-02-24"), mode: "image" },
  // Black Forest Labs FLUX
  "flux-1.1-pro-ultra": { releaseDate: iso("2024-11-06"), mode: "image" },
  "flux-2-flex": { releaseDate: iso("2025-11-25"), mode: "image" },
  "flux-kontext-max": { releaseDate: iso("2025-05-29"), mode: "image" },
  "flux-dev": { releaseDate: iso("2024-08-01"), mode: "image" },
  // OpenAI image
  "gpt-4o-image": { releaseDate: iso("2025-03-25"), mode: "image" },
  "gpt-image-1": { releaseDate: iso("2025-04-23"), mode: "image" },
  "gpt-image-1-mini": { releaseDate: iso("2025-10-06"), mode: "image" },
  "gpt-image-1.5": { releaseDate: iso("2025-12-16"), mode: "image" },
  "gpt-image-2": { releaseDate: iso("2026-04-21"), mode: "image" },
  // Stability AI / ByteDance SDXL
  "stable-diffusion-xl-base-1.0": {
    releaseDate: iso("2023-07-26"),
    mode: "image",
  },
  "stable-diffusion-xl-lightning": {
    releaseDate: iso("2024-02-21"),
    mode: "image",
  },

  // ─── Video-gen models (dates = public launch; suffix is snapshot code) ───
  "doubao-seedance-1-5-pro-251215": {
    releaseDate: iso("2025-12-16"),
    mode: "video",
  },
  "doubao-seedance-2-0-260128": {
    releaseDate: iso("2026-02-12"),
    mode: "video",
  },
  "doubao-seedance-2-0-fast-260128": {
    releaseDate: iso("2026-02-12"),
    mode: "video",
  },
};

export function buildCuratedSource(): PricingSource {
  return {
    name: "curated",
    pricing: buildFuzzyIndex(new Map<string, BaseModelPricing>()),
    metadata: buildFuzzyIndex(new Map(Object.entries(CURATED))),
  };
}
