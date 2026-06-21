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

// Known-WRONG upstream metadata that must be corrected even though a live source
// (usually litellm) carries it. Unlike CURATED (lowest priority, gap-fill only),
// these fields win over ALL sources. Keyed by BARE name. Use ONLY when a live
// source is factually wrong and verified against the official model card.
export const CURATED_OVERRIDE: Record<string, SourceMetadata> = {
  // litellm lists Apertus at 8192 ctx / no tools; HF model card = 65536, tools yes.
  "apertus-8b-instruct": { contextWindow: 65_536, maxInputTokens: 65_536, supportsTools: true },
  "apertus-70b-instruct": { contextWindow: 65_536, maxInputTokens: 65_536, supportsTools: true },
};

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
  // xAI Grok Imagine video (original feature launch)
  "grok-imagine-video": { releaseDate: iso("2025-08-07"), mode: "video" },
  // Kuaishou Kling Motion Control (shipped with Kling 2.6)
  "kling-motion-control": { releaseDate: iso("2025-12-03"), mode: "video" },
  // Alibaba Wan (2.5-Preview modes share the Sept launch; 2.6 = Dec)
  "wan2.5-i2i": { releaseDate: iso("2025-09-23"), mode: "video" },
  "wan2.5-i2v-preview": { releaseDate: iso("2025-09-23"), mode: "video" },
  "wan2.6-i2v": { releaseDate: iso("2025-12-16"), mode: "video" },

  // ─── Audio models (TTS / STT; no context window) ───
  // OpenAI Whisper (whisper-1 = hosted API on large-v2, Mar 2023 launch)
  "whisper-1": { releaseDate: iso("2023-03-01"), mode: "audio" },
  "whisper-large-v3": { releaseDate: iso("2023-11-06"), mode: "audio" },
  "whisper-large-v3-turbo": {
    releaseDate: iso("2024-10-01"),
    mode: "audio",
  },
  // OpenAI TTS (DevDay launch)
  "tts-1": { releaseDate: iso("2023-11-06"), mode: "audio" },
  "tts-1-hd": { releaseDate: iso("2023-11-06"), mode: "audio" },
  "gpt-4o-mini-tts": { releaseDate: iso("2025-03-20"), mode: "audio" },
  // Deepgram Aura-2
  "aura-2-en": { releaseDate: iso("2025-04-15"), mode: "audio" },
  "aura-2-es": { releaseDate: iso("2025-06-25"), mode: "audio" },
  // DeepL (translation API; date = API launch proxy)
  deepl: { releaseDate: iso("2018-03-01"), mode: "audio" },
  // ElevenLabs (Eleven Multilingual v2 GA)
  elevenlabs: { releaseDate: iso("2023-08-22"), mode: "audio" },
  // MyShell MeloTTS (earliest public tag; approximate)
  melotts: { releaseDate: iso("2024-02-29"), mode: "audio" },
  // Speechify SIMBA flagship (speechify-turbo date unpublished, left blank)
  speechify: { releaseDate: iso("2026-02-19"), mode: "audio" },

  // ─── Embedding models (context = max input tokens) ───
  // BAAI BGE
  "bge-base-en-v1.5": {
    releaseDate: iso("2023-09-12"),
    contextWindow: 512,
    mode: "embedding",
  },
  "bge-large-en-v1.5": {
    releaseDate: iso("2023-09-12"),
    contextWindow: 512,
    mode: "embedding",
  },
  "bge-small-en-v1.5": {
    releaseDate: iso("2023-09-12"),
    contextWindow: 512,
    mode: "embedding",
  },
  "bge-multilingual-gemma2": {
    releaseDate: iso("2024-07-26"),
    contextWindow: 4_096,
    mode: "embedding",
  },
  // Google
  "embeddinggemma-300m": {
    releaseDate: iso("2025-09-04"),
    contextWindow: 2_048,
    mode: "embedding",
  },
  "gemini-embedding-001": {
    releaseDate: iso("2025-07-14"),
    contextWindow: 2_048,
    mode: "embedding",
  },
  "gemini-embedding-2": {
    releaseDate: iso("2026-03-10"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "gemini-embedding-2-preview": {
    releaseDate: iso("2026-03-10"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  // Cohere Embed v3 family (shared launch) + v4
  "embed-english-v3.0": {
    releaseDate: iso("2023-11-02"),
    contextWindow: 512,
    mode: "embedding",
  },
  "embed-english-light-v3.0": {
    releaseDate: iso("2023-11-02"),
    contextWindow: 512,
    mode: "embedding",
  },
  "embed-multilingual-v3.0": {
    releaseDate: iso("2023-11-02"),
    contextWindow: 512,
    mode: "embedding",
  },
  "embed-multilingual-light-v3.0": {
    releaseDate: iso("2023-11-02"),
    contextWindow: 512,
    mode: "embedding",
  },
  "embed-v4.0": {
    releaseDate: iso("2025-04-15"),
    contextWindow: 128_000,
    mode: "embedding",
  },
  // Jina AI
  "jina-code-embeddings-0.5b": {
    releaseDate: iso("2025-09-04"),
    contextWindow: 32_768,
    mode: "embedding",
  },
  "jina-code-embeddings-1.5b": {
    releaseDate: iso("2025-09-04"),
    contextWindow: 32_768,
    mode: "embedding",
  },
  "jina-embeddings-v2-base-en": {
    releaseDate: iso("2023-10-28"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v2-base-zh": {
    releaseDate: iso("2024-01-09"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v2-base-de": {
    releaseDate: iso("2024-01-15"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v2-base-code": {
    releaseDate: iso("2024-02-05"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v2-base-es": {
    releaseDate: iso("2024-02-14"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v3": {
    releaseDate: iso("2024-09-18"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v4": {
    releaseDate: iso("2025-06-25"),
    contextWindow: 32_768,
    mode: "embedding",
  },
  "jina-embeddings-v5-text-nano": {
    releaseDate: iso("2026-02-18"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v5-text-small": {
    releaseDate: iso("2026-02-18"),
    contextWindow: 32_768,
    mode: "embedding",
  },
  "jina-embeddings-v5-omni-nano": {
    releaseDate: iso("2026-05-12"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "jina-embeddings-v5-omni-small": {
    releaseDate: iso("2026-05-12"),
    contextWindow: 32_768,
    mode: "embedding",
  },
  // NVIDIA NeMo Retriever (v1 = 512; nemotron v2 = 8192; vl = 10240)
  "llama-3.2-nv-embedqa-1b-v1": {
    releaseDate: iso("2024-10-29"),
    contextWindow: 512,
    mode: "embedding",
  },
  "llama-nemotron-embed-1b-v2": {
    releaseDate: iso("2025-10-16"),
    contextWindow: 8_192,
    mode: "embedding",
  },
  "llama-nemotron-embed-vl-1b-v2": {
    releaseDate: iso("2025-12-03"),
    contextWindow: 10_240,
    mode: "embedding",
  },
  "nv-embedqa-mistral-7b-v2": {
    releaseDate: iso("2024-08-01"),
    contextWindow: 512,
    mode: "embedding",
  },
  // Preferred Networks
  "plamo-embedding-1b": {
    releaseDate: iso("2025-04-11"),
    contextWindow: 4_096,
    mode: "embedding",
  },
  // Alibaba Qwen3-Embedding (shared launch)
  "qwen3-embedding-0.6b": {
    releaseDate: iso("2025-06-05"),
    contextWindow: 32_768,
    mode: "embedding",
  },
  "qwen3-embedding-8b": {
    releaseDate: iso("2025-06-05"),
    contextWindow: 32_768,
    mode: "embedding",
  },
  // OpenAI text-embedding-3 (shared launch)
  "text-embedding-3-large": {
    releaseDate: iso("2024-01-25"),
    contextWindow: 8_191,
    mode: "embedding",
  },
  "text-embedding-3-small": {
    releaseDate: iso("2024-01-25"),
    contextWindow: 8_191,
    mode: "embedding",
  },

  // ─── Text/chat backfill (nvy + relay-surfaced models) ───
  // Cohere Command A family
  "command-a-plus": {
    releaseDate: iso("2026-05-20"),
    contextWindow: 128_000,
    series: "Command",
    supportsTools: true,
  },
  "command-a-reasoning": {
    releaseDate: iso("2025-08-21"),
    contextWindow: 256_000,
    series: "Command",
    isReasoning: true,
    supportsTools: true,
  },
  "command-a-vision": {
    releaseDate: iso("2025-07-31"),
    contextWindow: 128_000,
    series: "Command",
    supportsVision: true,
    supportsTools: true,
  },
  "c4ai-aya-expanse-32b": {
    releaseDate: iso("2024-10-24"),
    contextWindow: 128_000,
    series: "Aya",
  },
  "c4ai-aya-vision-32b": {
    releaseDate: iso("2025-03-04"),
    contextWindow: 16_000,
    series: "Aya",
    supportsVision: true,
  },
  // DeepSeek R1 distills (released together; native 128K)
  "deepseek-r1-distill-llama-8b": {
    releaseDate: iso("2025-01-20"),
    contextWindow: 131_072,
    series: "DeepSeek",
    isReasoning: true,
  },
  "deepseek-r1-distill-qwen-14b": {
    releaseDate: iso("2025-01-20"),
    contextWindow: 131_072,
    series: "DeepSeek",
    isReasoning: true,
  },
  "deepseek-r1-distill-qwen-1.5b": {
    releaseDate: iso("2025-01-20"),
    contextWindow: 131_072,
    series: "DeepSeek",
    isReasoning: true,
  },
  "deepseek-r1-distill-qwen-7b": {
    releaseDate: iso("2025-01-20"),
    contextWindow: 131_072,
    series: "DeepSeek",
    isReasoning: true,
  },
  // DeepSeek reasoner API alias (rolling; mid-2026 = V4-Flash thinking, 1M)
  "deepseek-reasoner": {
    releaseDate: iso("2026-04-24"),
    contextWindow: 1_000_000,
    series: "DeepSeek",
    isReasoning: true,
    supportsTools: true,
  },
  // Mistral Devstral / Magistral / Ministral 3
  "devstral-small-2507": {
    releaseDate: iso("2025-07-10"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsTools: true,
  },
  "devstral-small-latest": {
    releaseDate: iso("2025-07-10"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsTools: true,
  },
  "devstral-medium-2507": {
    releaseDate: iso("2025-07-10"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsTools: true,
  },
  "devstral-medium-latest": {
    releaseDate: iso("2025-07-10"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsTools: true,
  },
  "devstral-latest": {
    releaseDate: iso("2025-07-10"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsTools: true,
  },
  "magistral-medium-2509": {
    releaseDate: iso("2025-09-18"),
    contextWindow: 131_072,
    series: "Mistral",
    isReasoning: true,
    supportsTools: true,
  },
  "magistral-medium-latest": {
    releaseDate: iso("2025-09-18"),
    contextWindow: 131_072,
    series: "Mistral",
    isReasoning: true,
    supportsTools: true,
  },
  "magistral-small-2509": {
    releaseDate: iso("2025-09-18"),
    contextWindow: 131_072,
    series: "Mistral",
    isReasoning: true,
    supportsTools: true,
  },
  "magistral-small-latest": {
    releaseDate: iso("2025-09-18"),
    contextWindow: 131_072,
    series: "Mistral",
    isReasoning: true,
    supportsTools: true,
  },
  "mistral-small-latest": {
    releaseDate: iso("2026-03-16"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "ministral-3-3b": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "ministral-3-8b": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "ministral-3-14b": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  // ByteDance Doubao 1.5
  "doubao-1.5-thinking-pro": {
    releaseDate: iso("2025-04-17"),
    contextWindow: 128_000,
    series: "Doubao",
    isReasoning: true,
  },
  "doubao-1.5-vision-pro": {
    releaseDate: iso("2025-01-22"),
    contextWindow: 128_000,
    series: "Doubao",
    supportsVision: true,
  },
  // Google Gemini 2.x (1M context)
  "gemini-2.0-flash": {
    releaseDate: iso("2025-02-05"),
    contextWindow: 1_048_576,
    series: "Gemini",
    supportsVision: true,
    supportsTools: true,
  },
  "gemini-2.5-flash-thinking": {
    releaseDate: iso("2025-06-17"),
    contextWindow: 1_048_576,
    series: "Gemini",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // gemini-flash-lite-latest = rolling alias; 2.5-flash-lite GA date as proxy
  "gemini-flash-lite-latest": {
    releaseDate: iso("2025-07-22"),
    contextWindow: 1_048_576,
    series: "Gemini",
    supportsVision: true,
    supportsTools: true,
  },
  // AI Singapore SEA-LION v4 (Gemma-based)
  "gemma-sea-lion-v4-27b": {
    releaseDate: iso("2025-08-11"),
    contextWindow: 131_072,
    series: "Gemma",
    supportsTools: true,
  },
  // Moonshot Kimi K2 0905
  "kimi-k2-instruct-0905": {
    releaseDate: iso("2025-09-05"),
    contextWindow: 262_144,
    series: "Kimi",
    supportsTools: true,
  },
  // NVIDIA Llama 3.1 Nemotron 70B
  "llama-3.1-nemotron-70b": {
    releaseDate: iso("2024-10-15"),
    contextWindow: 131_072,
    series: "Llama",
    supportsTools: true,
  },
  // Meta Llama 3 70B (native 8K)
  "llama-3-70b-instruct": {
    releaseDate: iso("2024-04-18"),
    contextWindow: 8_192,
    series: "Llama",
  },
  // Qwen
  "qwen2.5-coder-7b-instruct": {
    releaseDate: iso("2024-09-19"),
    contextWindow: 32_768,
    series: "Qwen",
    supportsTools: true,
  },
  "qwen3-4b-instruct-2507": {
    releaseDate: iso("2025-08-06"),
    contextWindow: 262_144,
    series: "Qwen",
    supportsTools: true,
  },
  "qwen3-max-preview": {
    releaseDate: iso("2025-09-05"),
    contextWindow: 262_144,
    series: "Qwen",
    supportsTools: true,
  },
  "qwen-vl-max-2025-01-25": {
    releaseDate: iso("2025-01-25"),
    contextWindow: 131_072,
    series: "Qwen",
    supportsVision: true,
    supportsTools: true,
  },
  // xAI Grok (fast = reasoning + non-reasoning share one launch + 2M ctx)
  "grok-4": {
    releaseDate: iso("2025-07-10"),
    contextWindow: 256_000,
    series: "Grok",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "grok-4-fast-reasoning": {
    releaseDate: iso("2025-09-19"),
    contextWindow: 2_000_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  "grok-4-fast-non-reasoning": {
    releaseDate: iso("2025-09-19"),
    contextWindow: 2_000_000,
    series: "Grok",
    supportsTools: true,
  },
  "grok-4.1-fast-reasoning": {
    releaseDate: iso("2025-11-19"),
    contextWindow: 2_000_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  "grok-4.1-fast-non-reasoning": {
    releaseDate: iso("2025-11-19"),
    contextWindow: 2_000_000,
    series: "Grok",
    supportsTools: true,
  },
  "grok-4.20-non-reasoning": {
    releaseDate: iso("2026-03-09"),
    contextWindow: 1_000_000,
    series: "Grok",
    supportsTools: true,
  },
  "grok-code-fast-1": {
    releaseDate: iso("2025-08-26"),
    contextWindow: 256_000,
    series: "Grok",
    supportsTools: true,
  },
  // Mistral Large / Medium / Pixtral / Devstral Small 2
  "mistral-large-latest": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 256_000,
    series: "Mistral",
    supportsTools: true,
  },
  "mistral-medium-2508": {
    releaseDate: iso("2025-08-12"),
    contextWindow: 128_000,
    series: "Mistral",
    supportsTools: true,
  },
  "mistral-medium-latest": {
    releaseDate: iso("2026-04-01"),
    contextWindow: 128_000,
    series: "Mistral",
    supportsTools: true,
  },
  "pixtral-large-2411": {
    releaseDate: iso("2024-11-18"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "pixtral-large-latest": {
    releaseDate: iso("2024-11-18"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "devstral-small-2": {
    releaseDate: iso("2025-12-09"),
    contextWindow: 256_000,
    series: "Mistral",
    supportsTools: true,
  },
  // Google Gemini 3.1 Flash Lite (preview)
  "gemini-3.1-flash-lite-thinking": {
    releaseDate: iso("2026-03-03"),
    contextWindow: 1_000_000,
    series: "Gemini",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Swiss AI (ETH Zurich + EPFL) Apertus 2509
  "apertus-8b-instruct": {
    releaseDate: iso("2025-09-02"),
    contextWindow: 65_536,
    series: "Apertus",
    isReasoning: true,
    supportsTools: true,
  },
  "apertus-70b-instruct": {
    releaseDate: iso("2025-09-02"),
    contextWindow: 65_536,
    series: "Apertus",
    isReasoning: true,
    supportsTools: true,
  },
  // EuroLLM (utter-project) 22B Instruct, Dec 2025 snapshot
  "eurollm-22b-instruct-2512": {
    releaseDate: iso("2025-12-05"),
    contextWindow: 32_768,
    series: "EuroLLM",
  },
  // Dicta DictaLM 3.0 24B Thinking (Hebrew/multilingual reasoning)
  "dictalm-3.0-24b-thinking": {
    releaseDate: iso("2025-12-10"),
    contextWindow: 65_280,
    series: "DictaLM",
    isReasoning: true,
    supportsTools: true,
  },
  // Meituan LongCat 2.0 Preview (closed, API-only; >1T MoE)
  "longcat-2.0-preview": {
    releaseDate: iso("2026-04-20"),
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    series: "LongCat",
    isReasoning: true,
    supportsTools: true,
  },
  // AI Singapore Qwen-SEA-LION v4 32B (Qwen3-based hybrid thinking)
  "qwen-sea-lion-v4-32b-it": {
    releaseDate: iso("2025-10-16"),
    contextWindow: 32_768,
    series: "Qwen",
    isReasoning: true,
  },
  // Mistral Large 3 (675B MoE, multimodal, Dec 2025)
  "mistral-large-3-675b": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 256_000,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  // NVIDIA Mistral-Nemotron (NIM-hosted, API-only)
  "mistral-nemotron": {
    releaseDate: iso("2025-06-11"),
    contextWindow: 128_000,
    series: "Mistral",
    supportsTools: true,
  },
  // ByteDance Seed-OSS 36B Instruct
  "seed-oss-36b": {
    releaseDate: iso("2025-08-20"),
    contextWindow: 524_288,
    series: "Seed",
    isReasoning: true,
    supportsTools: true,
  },
  // Alibaba Qwen2.5-VL 7B Instruct (vision)
  "qwen2.5-vl-7b-instruct": {
    releaseDate: iso("2025-01-26"),
    contextWindow: 32_768,
    series: "Qwen",
    supportsVision: true,
    supportsTools: true,
  },
  // Google Gemma 4 E2B Instruct (unsloth GGUF repackage served by Bleak)
  "gemma-4-e2b-it-gguf": {
    releaseDate: iso("2026-03-31"),
    contextWindow: 131_072,
    series: "Gemma",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // NVIDIA Nemotron 3 Ultra 550B-A55B (thinking mode; 1M architectural context)
  "nemotron-3-ultra-thinking": {
    releaseDate: iso("2026-06-04"),
    contextWindow: 1_000_000,
    series: "Nemotron",
    isReasoning: true,
    supportsTools: true,
  },
};

export function buildCuratedSource(): PricingSource {
  return {
    name: "curated",
    pricing: buildFuzzyIndex(new Map<string, BaseModelPricing>()),
    metadata: buildFuzzyIndex(new Map(Object.entries(CURATED))),
  };
}
