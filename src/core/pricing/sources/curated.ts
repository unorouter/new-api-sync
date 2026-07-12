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
  // Verified release dates (official sources) for models a live source carries
  // dateless, so plain CURATED (gap-fill) can't set them; hard-pin here.
  // Google Nano Banana Pro (Gemini 3 Pro Image Preview), launched 2025-11-20.
  "nano-banana-pro-preview": { releaseDate: iso("2025-11-20") },
  // Rolling alias to the latest Gemini Flash (approximate; tracks 2.5 Flash GA).
  "gemini-flash-latest": { releaseDate: iso("2025-09-25") },
  // Google Lyria 3 music gen: base 2026-02-18, Pro 2026-03-25.
  "lyria-3-clip-preview": { releaseDate: iso("2026-02-18") },
  "lyria-3-pro-preview": { releaseDate: iso("2026-03-25") },
  "deepseek-r1-distill-llama-8b": { releaseDate: iso("2025-01-20") },
  "deepseek-r1-distill-qwen-14b": { releaseDate: iso("2025-01-20") },
  "deepseek-r1-distill-qwen-7b": { releaseDate: iso("2025-01-20") },
  "qwen2.5-coder-7b-instruct": { releaseDate: iso("2024-09-19") },
  "qwen2.5-coder-3b-instruct": { releaseDate: iso("2024-11-12") },
  "qwen3-4b-instruct-2507": { releaseDate: iso("2025-08-06") },
  "qwen3-4b-thinking-2507": { releaseDate: iso("2025-08-06") },
  "qwen3-coder-480b-a35b-instruct": { releaseDate: iso("2025-07-22") },
  "qwen3-embedding-4b": { releaseDate: iso("2025-06-05") },
  "qwen3-embedding-8b": { releaseDate: iso("2025-06-05") },
  "qwen3-reranker-0.6b": { releaseDate: iso("2025-06-05") },
  "qwen3-reranker-8b": { releaseDate: iso("2025-06-05") },
  "whisper-large-v3": { releaseDate: iso("2023-11-07") },
  "flux.1-schnell": { releaseDate: iso("2024-08-01") },
  "flux-1.1-pro": { releaseDate: iso("2024-10-01") },
  "bge-reranker-v2-m3": { releaseDate: iso("2024-03-18") },
  "gpt-oss-120b": { releaseDate: iso("2025-08-05") },
  "deepseek-v3-0324": {
    releaseDate: iso("2025-03-24"),
    contextWindow: 128_000,
    series: "DeepSeek",
    supportsTools: true,
  },
  "deepseek-r1-0528": {
    releaseDate: iso("2025-05-28"),
    contextWindow: 128_000,
    series: "DeepSeek",
    isReasoning: true,
    supportsTools: true,
  },
  "deepseek-r1": {
    releaseDate: iso("2025-01-20"),
    contextWindow: 128_000,
    series: "DeepSeek",
    isReasoning: true,
    supportsTools: true,
  },
  "deepseek-v3": {
    releaseDate: iso("2024-12-26"),
    contextWindow: 128_000,
    series: "DeepSeek",
    supportsTools: true,
  },
  "deepseek-v3.2-speciale": {
    releaseDate: iso("2025-12-01"),
    contextWindow: 128_000,
    series: "DeepSeek",
    isReasoning: true,
    supportsTools: true,
  },
  "devstral-small-2": { releaseDate: iso("2025-07-11") },
  "grok-4": { releaseDate: iso("2025-07-09") },
  "grok-code-fast-1": { releaseDate: iso("2025-08-28") },
  "voyage-context-3": { releaseDate: iso("2025-07-23") },
  "grok-4-fast-reasoning": { releaseDate: iso("2025-09-19") },
  "grok-4-fast-non-reasoning": { releaseDate: iso("2025-09-19") },
  "grok-4.1-fast-reasoning": { releaseDate: iso("2025-11-01") },
  "grok-4.1-fast-non-reasoning": { releaseDate: iso("2025-11-01") },
  "grok-4.5": {
    releaseDate: iso("2026-07-08"),
    contextWindow: 500_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  // GPT-5.6 Sol/Terra/Luna: 3 durable tiers, 1.05M ctx / 128K out, GA 2026-07-09.
  // bare gpt-5.6 aliases to sol (mapped in config.yml modelMapping). Sol's xhigh +
  // ultra map onto "max" (top of the ladder in this enum).
  "gpt-5.6-sol": {
    releaseDate: iso("2026-07-09"),
    contextWindow: 1_050_000,
    series: "GPT",
    isReasoning: true,
    supportsTools: true,
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
  "gpt-5.6-terra": {
    releaseDate: iso("2026-07-09"),
    contextWindow: 1_050_000,
    series: "GPT",
    isReasoning: true,
    supportsTools: true,
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
  "gpt-5.6-luna": {
    releaseDate: iso("2026-07-09"),
    contextWindow: 1_050_000,
    series: "GPT",
    isReasoning: true,
    supportsTools: true,
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
  "gemini-2.5-computer-use-preview-10-2025": {
    releaseDate: iso("2025-10-07"),
  },
  // litellm lists Apertus at 8192 ctx / no tools; HF model card = 65536, tools yes.
  "apertus-8b-instruct": {
    contextWindow: 65_536,
    maxInputTokens: 65_536,
    supportsTools: true,
  },
  "apertus-70b-instruct": {
    contextWindow: 65_536,
    maxInputTokens: 65_536,
    supportsTools: true,
  },
  // Flash/turbo GLM tiers get fuzzy-matched to their base (glm-4.7, glm-5) by
  // other sources, which overstates context and drops the series. Hard-pin them.
  "glm-4.7-flash": {
    releaseDate: iso("2025-12-01"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  "glm-5-turbo": {
    releaseDate: iso("2026-01-15"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  // Upstream still dates -latest as Large v1 (2024-02-26); alias now = Large 3.
  "mistral-large-latest": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 256_000,
  },
  // litellm reports a sparse reasoning-effort flag set for the GPT-5 reasoning
  // models (often only none + max), so the parser drops low/medium/high. OpenAI
  // docs list the full ladder: none, low, medium (default), high, xhigh ("max").
  "gpt-5": {
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
  "gpt-5.1": {
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
  "gpt-5.2": {
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
  "gpt-5.4": {
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "max"],
  },
  "gpt-5.5": {
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
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
  // Alibaba API-only Qwen models: no OpenRouter/basellm listing, so releaseDate +
  // series never fill. Dates from each model's snapshot id (Alibaba names commercial
  // snapshots by release date) or the official announcement. series="Qwen".
  "qvq-max": {
    releaseDate: iso("2025-03-25"),
    contextWindow: 131_072,
    series: "Qwen",
  },
  "qwen-max": {
    releaseDate: iso("2025-01-28"),
    contextWindow: 32_768,
    series: "Qwen",
  },
  "qwen-flash": {
    releaseDate: iso("2025-07-28"),
    contextWindow: 1_000_000,
    series: "Qwen",
  },
  "qwen-flash-character": {
    releaseDate: iso("2025-07-28"),
    contextWindow: 32_768,
    series: "Qwen",
  },
  "qwen-turbo": {
    releaseDate: iso("2024-09-19"),
    contextWindow: 1_000_000,
    series: "Qwen",
  },
  "qwen-plus-latest": {
    releaseDate: iso("2025-04-28"),
    contextWindow: 1_000_000,
    series: "Qwen",
  },
  "qwen-plus-character": {
    releaseDate: iso("2025-04-28"),
    contextWindow: 32_768,
    series: "Qwen",
  },
  "qwen-coder-plus": {
    releaseDate: iso("2024-11-12"),
    contextWindow: 131_072,
    series: "Qwen",
  },
  "qwen-vl-plus": {
    releaseDate: iso("2025-01-25"),
    contextWindow: 131_072,
    series: "Qwen",
  },
  "qwen-omni-turbo": {
    releaseDate: iso("2025-01-19"),
    contextWindow: 32_768,
    series: "Qwen",
  },
  "qwq-plus": {
    releaseDate: iso("2025-03-05"),
    contextWindow: 131_072,
    series: "Qwen",
  },
  "qwq-plus-2025-03-05": {
    releaseDate: iso("2025-03-05"),
    contextWindow: 131_072,
    series: "Qwen",
  },
  "qwen3-omni-flash": {
    releaseDate: iso("2025-09-15"),
    contextWindow: 65_536,
    series: "Qwen",
  },
  "qwen3-omni-flash-2025-09-15": {
    releaseDate: iso("2025-09-15"),
    contextWindow: 65_536,
    series: "Qwen",
  },
  "qwen3-omni-flash-2025-12-01": {
    releaseDate: iso("2025-12-01"),
    contextWindow: 65_536,
    series: "Qwen",
  },
  "qwen3-vl-flash": {
    releaseDate: iso("2025-10-15"),
    contextWindow: 262_144,
    series: "Qwen",
  },
  "qwen3-vl-flash-2025-10-15": {
    releaseDate: iso("2025-10-15"),
    contextWindow: 262_144,
    series: "Qwen",
  },
  "qwen3-vl-flash-2026-01-22": {
    releaseDate: iso("2026-01-22"),
    contextWindow: 262_144,
    series: "Qwen",
  },
  "qwen3-vl-plus": {
    releaseDate: iso("2025-09-23"),
    contextWindow: 262_144,
    series: "Qwen",
  },
  "qwen3-vl-plus-2025-09-23": {
    releaseDate: iso("2025-09-23"),
    contextWindow: 262_144,
    series: "Qwen",
  },
  "qwen3-vl-plus-2025-12-19": {
    releaseDate: iso("2025-12-19"),
    contextWindow: 262_144,
    series: "Qwen",
  },
  "qwen3.5-omni-flash": {
    releaseDate: iso("2026-03-15"),
    contextWindow: 49_152,
    series: "Qwen",
  },
  "qwen3.5-omni-flash-2026-03-15": {
    releaseDate: iso("2026-03-15"),
    contextWindow: 49_152,
    series: "Qwen",
  },
  "qwen3.5-omni-plus": {
    releaseDate: iso("2026-03-15"),
    contextWindow: 983_040,
    series: "Qwen",
  },
  "qwen3.5-omni-plus-2026-03-15": {
    releaseDate: iso("2026-03-15"),
    contextWindow: 983_040,
    series: "Qwen",
  },
  "qwen3.7-max-preview": {
    releaseDate: iso("2026-05-19"),
    contextWindow: 1_000_000,
    series: "Qwen",
  },
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
    releaseDate: iso("2025-09-02"),
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
  "llama-3.1-nemotron-nano-8b-v1": {
    releaseDate: iso("2025-03-18"),
    contextWindow: 131_072,
    series: "Llama",
    isReasoning: true,
    supportsTools: true,
  },
  "llama-3.1-nemotron-nano-vl-8b-v1": {
    releaseDate: iso("2025-06-03"),
    contextWindow: 16_384,
    series: "Llama",
    supportsVision: true,
    supportsTools: true,
  },
  "gemini-robotics-er-1.6-preview": {
    releaseDate: iso("2026-04-14"),
    contextWindow: 128_000,
    series: "Gemini",
    supportsVision: true,
  },
  "nemotron-3-nano-omni-30b-a3b-reasoning": {
    releaseDate: iso("2026-04-28"),
    contextWindow: 262_144,
    series: "Nemotron",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Agnes AI (Sapiens AI) house models. 2.0-flash rolled its 1M context back to
  // 256K in June 2026; supports thinking, streaming, tools, vision.
  "agnes-2.0-flash": {
    releaseDate: iso("2026-06-01"),
    contextWindow: 262_144,
    series: "Agnes",
    supportsVision: true,
    supportsTools: true,
  },
  "agnes-1.5-flash": {
    releaseDate: iso("2026-03-01"),
    contextWindow: 131_072,
    series: "Agnes",
    supportsTools: true,
  },
  // Mistral Leanstral (served free via Requesty). 262K context, tool calling.
  "leanstral-1-5": {
    releaseDate: iso("2026-05-01"),
    contextWindow: 262_144,
    series: "Mistral",
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
  // Venice commercial aliases of Dolphin-Mistral-24B-Venice-Edition (Venice launch 2025-07-09)
  "venice-uncensored": {
    releaseDate: iso("2025-07-09"),
    contextWindow: 32_768,
    series: "Mistral",
  },
  "venice-uncensored-role-play": {
    releaseDate: iso("2025-07-09"),
    contextWindow: 128_000,
    series: "Mistral",
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
  "flux.1-schnell": { releaseDate: iso("2024-08-01"), mode: "image" },
  // OpenAI image
  "dall-e-3": { releaseDate: iso("2023-10-19"), mode: "image" },
  "gpt-4o-image": { releaseDate: iso("2025-03-25"), mode: "image" },
  "gpt-image-1": { releaseDate: iso("2025-04-23"), mode: "image" },
  "gpt-image-1-mini": { releaseDate: iso("2025-10-06"), mode: "image" },
  "gpt-image-1.5": { releaseDate: iso("2025-12-16"), mode: "image" },
  "gpt-image-2": { releaseDate: iso("2026-04-21"), mode: "image" },
  // AI Horde uncensored image finetunes (bare names after :free strip + lowercase)
  deliberate: {
    releaseDate: iso("2022-11-21"),
    series: "Stable Diffusion",
    mode: "image",
  },
  "stable-diffusion": {
    releaseDate: iso("2022-08-22"),
    series: "Stable Diffusion",
    mode: "image",
  },
  "albedobase-xl-3.1": {
    releaseDate: iso("2024-06-01"),
    series: "SDXL",
    mode: "image",
  },
  "juggernaut-xl": {
    releaseDate: iso("2024-02-01"),
    series: "SDXL",
    mode: "image",
  },
  "wai-nsfw-illustrious-sdxl": {
    releaseDate: iso("2024-11-01"),
    series: "SDXL",
    mode: "image",
  },
  "pony-realism": {
    releaseDate: iso("2024-08-01"),
    series: "Pony",
    mode: "image",
  },
  "nova-anime-xl": {
    releaseDate: iso("2024-09-01"),
    series: "Pony",
    mode: "image",
  },
  "nova-furry-pony": {
    releaseDate: iso("2024-10-01"),
    series: "Pony",
    mode: "image",
  },
  // AI Horde full image catalog (auto-generated from AI-Horde-image-model-reference)
  "2dn": { releaseDate: iso("2024-06-18"), series: "SDXL", mode: "image", description: "2DN is a NAI-based model that is capable of generating high-quality semi-realistic images." },
  "526mix-animated": { releaseDate: iso("2023-04-01"), series: "Stable Diffusion", mode: "image", description: "The goal of this model was to anchor 526Mix's whimsical and artistic personality into anime. 526Mix can do a pretty cool anime style (and other 2D styles), but it can be a bit unreliable at times. ..." },
  "a-zovya-rpg-inpainting": { releaseDate: iso("2023-02-12"), series: "Stable Diffusion", mode: "image", description: "The inpainting version of A-Zovya RPG" },
  "aam-xl": { releaseDate: iso("2024-01-18"), series: "SDXL", mode: "image", description: "Anime screencap model, brought to you by the creator of DreamShaper" },
  "absolutereality": { releaseDate: iso("2023-05-31"), series: "Stable Diffusion", mode: "image", description: "That feeling when you wake up after a dream.  This is a fantastic sd1.5 realism bought to you by the creator of DreamShaper" },
  "abyss-orangemix": { releaseDate: iso("2022-12-04"), series: "Stable Diffusion", mode: "image", description: "A model trained to create CG anime characters" },
  "acertainthing": { releaseDate: iso("2022-12-13"), series: "Stable Diffusion", mode: "image", description: "An improved version of Anything v3 made with ACertainThing, focusing on scenes rather than characters" },
  "aio-pixel-art": { releaseDate: iso("2022-11-09"), series: "Stable Diffusion", mode: "image", description: "Stable Diffusion fine tuned on pixel art sprites and scenes" },
  "albedobase-xl-sdxl": { releaseDate: iso("2023-09-05"), series: "SDXL", mode: "image", description: "SDXL Model that doesn't require a refiner." },
  "albedobase-xl-31": { releaseDate: iso("2023-09-05"), series: "SDXL", mode: "image", description: "SDXL Model that doesn't require a refiner. This is the 3.1 version." },
  "amponyxl": { releaseDate: iso("2024-02-02"), series: "Pony", mode: "image", description: "Anime model based on Pony Diffusion XL - remember to use the score prompts to get this to go properly" },
  "analog-diffusion": { releaseDate: iso("2022-12-10"), series: "Stable Diffusion", mode: "image", description: "A dreambooth model trained on a diverse set of analog photographs" },
  "analog-madness": { releaseDate: iso("2023-02-11"), series: "Stable Diffusion", mode: "image", description: "A very versatile model, the more powerfull prompts you give, the better results. Capable of creating both NSFW and SFW images but also great scenery, both in landscape and portrait." },
  "animagine-xl": { releaseDate: iso("2023-11-23"), series: "SDXL", mode: "image", description: "Animagine XL is the sophisticated open-source anime text-to-image model, building upon the capabilities of its predecessor, Animagine XL 2.0. Developed based on Stable Diffusion XL, this iteration ..." },
  "anime-pencil-diffusion": { releaseDate: iso("2022-12-03"), series: "Stable Diffusion", mode: "image", description: "A dreambooth finetune of stable diffusion 1.5 model that will output stuff in anime pencil concept drawing style." },
  "anygen": { releaseDate: iso("2023-01-04"), series: "Stable Diffusion", mode: "image", description: "A best of both worlds - merging the anime of Anything v3 with Protogens photorealism - VAE is included" },
  "anylora": { releaseDate: iso("2023-03-24"), series: "Stable Diffusion", mode: "image", description: "This is good for inference (again, especially with styles) even if I made it mainly for training. It ended up being super good for generating pics and it's now my go-to anime model. It also eats ve..." },
  "anything-diffusion": { releaseDate: iso("2023-01-20"), series: "Stable Diffusion", mode: "image", description: "Highly detailed Anime styled generations" },
  "anything-diffusion-inpainting": { releaseDate: iso("2023-02-01"), series: "Stable Diffusion", mode: "image", description: "The inpainting version of Anything Diffusion" },
  "anything-v5": { releaseDate: iso("2023-02-16"), series: "Stable Diffusion", mode: "image", description: "Anything V5, see the project homepage" },
  "app-icon-diffusion": { releaseDate: iso("2022-11-01"), series: "Stable Diffusion", mode: "image", description: "Dreambooth model fine tuned on mobile app icons" },
  "art-of-mtg": { releaseDate: iso("2022-11-20"), series: "Stable Diffusion", mode: "image", description: "Experimenal model, based on ~5000 arts for cards from Magic: the Gathering game on top of SD1.5 model. Large variety of cards from 2014 to 2022 was used. Logos, guild/clan icons and mana symbols we..." },
  "aurora": { releaseDate: iso("2023-04-14"), series: "Stable Diffusion", mode: "image", description: "Aurora is a Stable Diffusion model, similar to its predecessor Kenshi, with the goal of capturing my own feelings towards the anime styles I desire.The name Aurora, which means 'dawn' in Latin, rep..." },
  "babes": { releaseDate: iso("2022-12-23"), series: "Stable Diffusion", mode: "image", description: "Trained on 1600 images from a few styles(see trigger words), with an enhanced realistic style, in 4 cycles of training. Trained on 576px and 960px, 80+ hours of successful training, and countless h..." },
  "bb95-furry-mix-v14": { releaseDate: iso("2023-03-09"), series: "Stable Diffusion", mode: "image", description: "This model is a mix of various furry models." },
  "bigasp": { releaseDate: iso("2024-06-08"), series: "SDXL", mode: "image", description: "BigASP is a photorealistic model designed for generating high-quality images with a variety of prompt lengths and amounts of detail." },
  "blank-canvas-xl": { releaseDate: iso("2024-01-27"), series: "SDXL", mode: "image", description: "Another model from RCNZ, this one is a true generalist, able to do realism, anime, and cartoons" },
  "blendermix-pony": { releaseDate: iso("2024-03-21"), series: "Pony", mode: "image", description: "This PonyXL checkpoint should create a blender animation style look. Model was merged using my loras (Fugtrup, Nyl2, RadRoachHD) and AutismMix. I also added a tiny pinch of DucHaiten-GameArt to add..." },
  "bweshmix": { releaseDate: iso("2023-05-13"), series: "Stable Diffusion", mode: "image", description: "Should be able to do very good anime 2.5D illustration style by default. And also accepts artist and style prompts easily. So you can make more 2d or artistic styles. Please don't expect super clea..." },
  "camelliamix-25d": { releaseDate: iso("2023-04-18"), series: "Stable Diffusion", mode: "image", description: "Semi-realistic model, Camellia Mix 2.5D V2" },
  "cetus-mix": { releaseDate: iso("2023-02-05"), series: "Stable Diffusion", mode: "image", description: "A popular anime model" },
  "cheese-daddys-landscape-mix": { releaseDate: iso("2023-01-22"), series: "Stable Diffusion", mode: "image", description: "This model is tweak and more merges mainly intended for landscapes, but works decent for people" },
  "cheyenne": { releaseDate: iso("2023-11-12"), series: "SDXL", mode: "image", description: "A model for European Comic lovers" },
  "comic-diffusion": { releaseDate: iso("2022-10-28"), series: "Stable Diffusion", mode: "image", description: "Western Comic book style" },
  "counterfeit": { releaseDate: iso("2023-01-13"), series: "Stable Diffusion", mode: "image", description: "Counterfeit is anime style Stable Diffusion model" },
  "cyberrealistic-pony": { releaseDate: iso("2024-05-08"), series: "Pony", mode: "image", description: "Cyberrealistic Pony is a semi-realistic Pony model capable of SFW and NSFW portraits as well as scenery." },
  "cyriousmix": { releaseDate: iso("2023-02-02"), series: "Stable Diffusion", mode: "image", description: "Mostly NSFW, semi-realistic anime characters" },
  "dan-mumford-style": { releaseDate: iso("2023-01-15"), series: "Stable Diffusion", mode: "image", description: "Model trained with a dataset of DanMumford Style images, courtesy of Flonix" },
  "deliberate-30": { releaseDate: iso("2023-11-06"), series: "Stable Diffusion", mode: "image", description: "Based on the already popular model Deliberate, this model is a more refined version of it." },
  "deliberate-inpainting": { releaseDate: iso("2022-12-01"), series: "Stable Diffusion", mode: "image", description: "The inpainting version of Deliberate" },
  "double-exposure-diffusion": { releaseDate: iso("2022-11-14"), series: "Stable Diffusion", mode: "image", description: "The Double Exposure Diffusion model, trained specifically on images of people and a few animals" },
  "dreamlike-diffusion": { releaseDate: iso("2022-12-11"), series: "Stable Diffusion", mode: "image", description: "Dreamlike Diffusion 1.0 is SD 1.5 fine tuned on high quality art, made by dreamlike.art" },
  "dreamshaper": { releaseDate: iso("2023-01-12"), series: "Stable Diffusion", mode: "image", description: "Merged model mix of Midnight mixer, roboEtics, f222, elldrethSLucidMix, Seek.ART Mega, rpg, hassanBlend, modelshoot and roboDiffusion" },
  "dreamshaper-inpainting": { releaseDate: iso("2023-01-12"), series: "Stable Diffusion", mode: "image", description: "The inpainting version of DreamShaper" },
  "dreamshaper-xl": { releaseDate: iso("2023-07-20"), series: "SDXL", mode: "image", description: "DreamShaper is a general purpose SD model that aims at doing everything well, photos, art, anime, manga. It's designed to go against other general purpose models and pipelines like Midjourney and D..." },
  "duchaiten": { releaseDate: iso("2023-01-06"), series: "Stable Diffusion", mode: "image", description: "DucHaiten's character generation model" },
  "duchaiten-classic-anime": { releaseDate: iso("2023-03-01"), series: "Stable Diffusion", mode: "image", description: "DucHaiten's classic anime charecter model, similar to 80's/90's artwork" },
  "duchaiten-gameart-unreal-pony": { releaseDate: iso("2024-04-07"), series: "Pony", mode: "image", description: "This is a 3D PonyXL model, based on the AAA game quality of Unreal Engine 5." },
  "dungeons-and-diffusion": { releaseDate: iso("2022-11-06"), series: "Stable Diffusion", mode: "image", description: "Generates D&D styled characters, trained on art commissions. *many* species and classes available, see homepage" },
  "dungeons-n-waifus": { releaseDate: iso("2023-02-22"), series: "Stable Diffusion", mode: "image", description: "A handpicked and curated merge of the best of the best in fantasy world, character & creature design. Should serve as a bit of a swiss army knife / multi-tool to create any and all fantasy art, cha..." },
  "edge-of-realism": { releaseDate: iso("2023-03-20"), series: "Stable Diffusion", mode: "image", description: "A spin off from Level4. Built to produce high quality photos. Sometimes photos will come out as uncanny as they are on the edge of realism." },
  "eimis-anime-diffusion": { releaseDate: iso("2022-11-15"), series: "Stable Diffusion", mode: "image", description: "This model is trained with high quality and detailed anime images" },
  "elysium-anime": { releaseDate: iso("2023-02-13"), series: "Stable Diffusion", mode: "image", description: "Anime version of Elysium, detailed versatile anime style." },
  "epic-diffusion": { releaseDate: iso("2023-01-05"), series: "Stable Diffusion", mode: "image", description: "Epic Diffusion is a general purpose model based on Stable Diffusion 1.x intended to replace the official SD releases as your default model. It is focused on providing high quality output in a wide ..." },
  "epic-diffusion-inpainting": { releaseDate: iso("2023-01-05"), series: "Stable Diffusion", mode: "image", description: "The inpainting version of Epic Diffusion" },
  "ether-real-mix": { releaseDate: iso("2023-03-11"), series: "Stable Diffusion", mode: "image", description: "Ether Real Mix is a realistic to semi-realistic anime style model tuned with the flexibility for general purpose use (hopefully). It still has some shortcomings inherit to anime models such as bias..." },
  "experience": { releaseDate: iso("2023-01-31"), series: "Stable Diffusion", mode: "image", description: "A generalist model with a slight leaning towards science-fiction and 3d renders" },
  "expmix-line": { releaseDate: iso("2023-02-15"), series: "Stable Diffusion", mode: "image", description: "Realistic anime styled drawings with extra emphasis on outlines" },
  "faetastic": { releaseDate: iso("2023-02-28"), series: "Stable Diffusion", mode: "image", description: "A beautiful mixed model (22 mixes) including Noise Offset to create a wide-range of images" },
  "fantasy-card-diffusion": { releaseDate: iso("2022-11-22"), series: "Stable Diffusion", mode: "image", description: "fantasy trading card style art, trained on all currently available Magic: the Gathering card art" },
  "flat-2d-animerge": { releaseDate: iso("2023-04-10"), series: "Stable Diffusion", mode: "image", description: "This is a merge of some random anime based and cartoon based models to achieve a somewhat cartoony anime style, more similar to what you would actually see in anime as opposed to the more common hy..." },
  "flux1-schnell-fp8-compact": { releaseDate: iso("2024-08-11"), series: "FLUX", mode: "image", description: "FLUX.1 [schnell] is a 12 billion parameter rectified flow transformer capable of generating images from text descriptions. For more information, please read our blog post. https://blackforestlabs.ai/" },
  "fustercluck": { releaseDate: iso("2023-12-12"), series: "SDXL", mode: "image", description: "SDXL Model for cartoony style. If it's not cartoony enough, you may need to add 'anime, cartoon' to the front of the positive prompt to push the image in the right direction" },
  "galena-redux": { releaseDate: iso("2023-07-01"), series: "Stable Diffusion", mode: "image", description: "This is an NSFW prone model. It is meant to generate primarily women and NSFW scenarios. This was made with the new base model merged together, alongside several style LoRA's." },
  "ghibli-diffusion": { releaseDate: iso("2022-11-18"), series: "Stable Diffusion", mode: "image", description: "fine-tuned Stable Diffusion model trained on images from Studio Ghibli feature films" },
  "ghostmix": { releaseDate: iso("2023-04-17"), series: "Stable Diffusion", mode: "image", description: "This Checkpoint works well on both SFW and NSFW" },
  "grapefruit-hentai": { releaseDate: iso("2023-03-26"), series: "Stable Diffusion", mode: "image", description: "Grapefruit aims to be a hentai model with a bright and more softer anime style." },
  "gta5-artwork-diffusion": { releaseDate: iso("2022-12-13"), series: "Stable Diffusion", mode: "image", description: "This model was trained on the loading screens, gta storymode, and gta online DLCs artworks. Which includes characters, background, chop, and some objects. The model can do people and portrait prett..." },
  "hasdx": { releaseDate: iso("2023-01-04"), series: "Stable Diffusion", mode: "image", description: "He merged a few checkpoints and got something buttery and amazing. Does great with things other then people too. It can do anything really. It doesn't need crazy prompts either. Keep it simple. No ..." },
  "hassaku-xl": { releaseDate: iso("2023-09-04"), series: "SDXL", mode: "image", description: "Hassaku aims to be a model with a bright, clear anime style." },
  "healys-anime-blend": { releaseDate: iso("2022-12-01"), series: "Stable Diffusion", mode: "image", description: "This is a blend of some anime models mixed with 'realistic' stuff" },
  "holymix-ilxl": { releaseDate: iso("2024-11-18"), series: "SDXL", mode: "image", description: "HolyMix Illustrious XL is a high-contrast, flat shading anime model. It supports multiple characters in the same image, as well as many more artist tags and characters as compared to Pony models." },
  "hrl": { releaseDate: iso("2023-02-16"), series: "Stable Diffusion", mode: "image", description: "Hyper Realistic Looking" },
  "icbinp-i-cant-believe-its-not-photography": { releaseDate: iso("2023-04-02"), series: "Stable Diffusion", mode: "image", description: "Following on from Gorilla With A Brick, merged in 10 more photorealistic models at various weights, and some more noise offset to create something that when prompted for photorealism will make you ..." },
  "icbinp-xl": { releaseDate: iso("2023-12-11"), series: "SDXL", mode: "image", description: "The SDXL follow up to ICBINP, now with higher resolution and better realism" },
  "icomix": { releaseDate: iso("2023-04-12"), series: "Stable Diffusion", mode: "image", description: "Comic style mix" },
  "icomix-inpainting": { releaseDate: iso("2023-04-12"), series: "Stable Diffusion", mode: "image", description: "The inpainting version of iCoMix" },
  "illuminati-diffusion": { releaseDate: iso("2023-11-19"), series: "Stable Diffusion", mode: "image", description: "Illuminati Diffusion is a latent text-to-image diffusion model that has been conditioned on high aesthetic synthetic images through fine-tuning. It was trained on 82,000 images locally with a singl..." },
  "inkpunk-diffusion": { releaseDate: iso("2022-11-25"), series: "Stable Diffusion", mode: "image", description: "inspired by Gorillaz art, FLCL and Yoji Shinkawa. Trained on images generated from Midjourney" },
  "jim-eidomode": { releaseDate: iso("2023-02-19"), series: "Stable Diffusion", mode: "image", description: "I have created something amazing that creates very stylized images, especially digital art. The model is good at creating animals, women, men, fantastic landscapes and much more." },
  "kaynegillustriousxl": { releaseDate: iso("2025-01-15"), series: "SDXL", mode: "image", description: "Anime-style model, excellent for close-up portraits." },
  "lawlass-yiff-mix": { releaseDate: iso("2023-02-25"), series: "Stable Diffusion", mode: "image", description: "Based on yiffy-e18 and Anything, produces sfw/nsfw furry anthro artworks of different styles with consistant quality, while maintaining details on stuff like clothes, background, etc. with simpler ..." },
  "liberty": { releaseDate: iso("2023-01-31"), series: "Stable Diffusion", mode: "image", description: "A merge with over 23 other models with a methodical, careful and genuine approach. Freedom of prompting art or photo or both, landscapes or backgrounds or interiors, people or entities or scenes, s..." },
  "lyriel": { releaseDate: iso("2023-05-16"), series: "Stable Diffusion", mode: "image", description: "This model is generally designed for portraits and full-length anime style photos. Fantastic landscapes are quite decent. And it doesn't require kilometer-long queries to get a high-quality result." },
  "majicmix-realistic": { releaseDate: iso("2023-04-26"), series: "Stable Diffusion", mode: "image", description: "A good looking model, suitable for NSFW and dark scene." },
  "meinamix": { releaseDate: iso("2023-02-07"), series: "Stable Diffusion", mode: "image", description: "MeinaMix's objective is to be able to do good art with little prompting." },
  "mhxl-aventis-horizon": { releaseDate: iso("2024-03-01"), series: "SDXL", mode: "image", description: "Generalist model, focusing on semi-realistic yet stylized generations." },
  "midjourney-paintart": { releaseDate: iso("2022-11-24"), series: "Stable Diffusion", mode: "image", description: "Midjourney v4 painting style" },
  "modernart-diffusion": { releaseDate: iso("2023-01-02"), series: "Stable Diffusion", mode: "image", description: "You can use this model to generate modernart style images" },
  "moonmix-fantasy": { releaseDate: iso("2023-04-18"), series: "Stable Diffusion", mode: "image", description: "This model is the result of merging several checkpoint models. See homepage for details." },
  "movie-diffusion": { releaseDate: iso("2023-02-11"), series: "Stable Diffusion", mode: "image", description: "Movie Diffusion is SD 1.5 trained on 35mm film stills from popular movies." },
  "natvis": { releaseDate: iso("2024-08-02"), series: "SDXL", mode: "image", description: "Realistic finetune of SDXL, with an emphasis on natural language prompting. Can produce both SFW and NSFW images." },
  "neurogen": { releaseDate: iso("2023-03-19"), series: "Stable Diffusion", mode: "image", description: "This model gives a very good detail of skin and textures. Great for close-up photorealistic portraits as well as various characters and models." },
  "neverending-dream": { releaseDate: iso("2023-02-18"), series: "Stable Diffusion", mode: "image", description: "This is a dream that you will never want to wake up from. A NeverEnding Dream.  Similar to Dreamshaper, but able to use danbooru tags" },
  "new-era": { releaseDate: iso("2023-08-31"), series: "SDXL", mode: "image", description: "NEW ERA (New Era Retro Anime) is a anime model that is designed to generate high-quality anime images with a retro anime aesthetic." },
  "noob-v-pencil-xl": { releaseDate: iso("2024-12-11"), series: "SDXL", mode: "image", description: "Vibrant anime-style images. Based on NoobAI-XL" },
  "noobevo": { releaseDate: iso("2024-12-20"), series: "SDXL", mode: "image", description: "Anime-styled model, with an emphasis on vibrant colors and detailed renders" },
  "ntr-mix-il-noob-xl": { releaseDate: iso("2024-11-07"), series: "SDXL", mode: "image", description: "NTR Mix Illustrious Noob XL is a anime model that can generate stylized anime images, both SFW and NSFW. It can generate both singular portraits and images with multiple characters in them." },
  "pastel-mix": { releaseDate: iso("2023-01-25"), series: "Stable Diffusion", mode: "image", description: "The model is trained with beautiful, artist-agnostic watercolor images using the midjourney method" },
  "perfect-world": { releaseDate: iso("2023-02-12"), series: "Stable Diffusion", mode: "image", description: "The pursuit of perfect balance between realism and anime, a semi-realistic model aimed to achieve beautiful realistic faces with sexy hentai bodies." },
  "photon": { releaseDate: iso("2023-06-06"), series: "Stable Diffusion", mode: "image", description: "Another fantastic realism model" },
  "poison": { releaseDate: iso("2022-11-24"), series: "Stable Diffusion", mode: "image", description: "Anything Diffusion fine-tuned to produce high-quality realistic anime styled images" },
  "pony-diffusion-xl": { releaseDate: iso("2024-01-13"), series: "Pony", mode: "image", description: "Pony Diffusion V6 is a versatile SDXL finetune capable of producing stunning SFW and NSFW visuals of various anthro, feral, or humanoids species and their interactions based on simple natural langu..." },
  "ppp": { releaseDate: iso("2022-12-08"), series: "Stable Diffusion", mode: "image", description: "PPP is a realistic model merge, tested and tweaked for human females. Mostly based on NSFW models" },
  "prefect-pony": { releaseDate: iso("2024-05-06"), series: "Pony", mode: "image", description: "Anime Pony model with an emphasis on NSFW and LoRA support" },
  "pretty-25d": { releaseDate: iso("2023-05-01"), series: "Stable Diffusion", mode: "image", description: "Realistic anime/cartoon styled drawings" },
  "project-unreal-engine-5": { releaseDate: iso("2022-12-15"), series: "Stable Diffusion", mode: "image", description: "This checkpoint is trained to look like Unreal Engine 5 renders" },
  "quiet-goodnight-xl": { releaseDate: iso("2024-03-05"), series: "SDXL", mode: "image", description: "SDXL Model for anime, bought to you from the maker of ICBINP" },
  "real-dos-mix": { releaseDate: iso("2023-02-06"), series: "Stable Diffusion", mode: "image", description: "As it is a semi-realistic model, we do not recommend inappropriate exposure." },
  "realbiter": { releaseDate: iso("2023-03-06"), series: "Stable Diffusion", mode: "image", description: "This blend model aims to achieve versatility in generating images that are almost realistic but with a touch of fantasy and a polished aesthetic. It performs well with both illustrations and simula..." },
  "realism-engine": { releaseDate: iso("2023-06-01"), series: "Stable Diffusion", mode: "image", description: "This new model was fine-tuned using a vast collection of public domain images, ensuring that it can generate images across a wide range of contexts. While it may not be as strong in generating abst..." },
  "realistic-vision": { releaseDate: iso("2023-01-15"), series: "Stable Diffusion", mode: "image", description: "Model for creating photorealistic humans" },
  "realistic-vision-inpainting": { releaseDate: iso("2023-01-15"), series: "Stable Diffusion", mode: "image", description: "The inpainting version of Realistic Vision" },
  "reliberate": { releaseDate: iso("2023-08-01"), series: "Stable Diffusion", mode: "image", description: "Reliberate is not a new version of Deliberate. I separate both evolutions / elaborations from each other, and made Reliberate model for those who need to work with photographic style. Yes, you can ..." },
  "rev-animated": { releaseDate: iso("2023-03-06"), series: "Stable Diffusion", mode: "image", description: "This model is mainly intended for Portraits and Full Body Anime-like pictures. Fantasy landscapes are decent." },
  "rpg": { releaseDate: iso("2022-11-28"), series: "Stable Diffusion", mode: "image", description: "portraits of charecters in the style of the game Baldur's Gate. check homepage for a massive prompt guide" },
  "sci-fi-diffusion": { releaseDate: iso("2023-01-08"), series: "Stable Diffusion", mode: "image", description: "A Sci-Fi themed model trained on SD 1.5 with a 26K+ image dataset" },
  "sd-silicon": { releaseDate: iso("2023-02-24"), series: "Stable Diffusion", mode: "image", description: "SD-Silicon: A series of general-purpose models based off the experimental automerger, autoMBW." },
  "sdxl-10": { releaseDate: iso("2023-07-25"), series: "SDXL", mode: "image", description: "The base SDXL 1.0 model." },
  "something": { releaseDate: iso("2023-03-08"), series: "Stable Diffusion", mode: "image", description: "A lot of things are being discovered lately, such as a way to merge model using mbw automatically, offset noise to get much darker result, and even VAE tuning. This anime model is intended to use a..." },
  "stable-cascade-10": { releaseDate: iso("2024-02-13"), series: "Stable Cascade", mode: "image", description: "This model is built upon the Wurstchen architecture and its main difference to other models like Stable Diffusion is that it is working at a much smaller latent space." },
  "stable-diffusion-inpainting": { releaseDate: iso("2022-10-20"), series: "Stable Diffusion", mode: "image", description: "Generalist model specialized for modifying areas of existing images" },
  "swamponyxl": { releaseDate: iso("2024-04-23"), series: "Pony", mode: "image", description: "Realistic finetune of Pony Diffusion V6, with an emphasis on asian likeness." },
  "toonyou": { releaseDate: iso("2023-06-25"), series: "Stable Diffusion", mode: "image", description: "Silly, stylish, and.. kind of cute? A bit of detail with a cartoony feel." },
  "tunix-pony": { releaseDate: iso("2024-07-05"), series: "Pony", mode: "image", description: "Semi-realistic stylized PonyXL finetune" },
  "uhmami": { releaseDate: iso("2023-02-13"), series: "Stable Diffusion", mode: "image", description: "a blend of anime-focused models with a semi-realistic aesthetic, combining 3D digital imagery with photography. It allows the use of prompts based on booru tags, similar to the novelai model, resul..." },
  "ultraspice": { releaseDate: iso("2023-05-01"), series: "SDXL", mode: "image", description: "Ultraspice is a highly realistic SDXL model." },
  "unstable-diffusers-xl": { releaseDate: iso("2024-01-28"), series: "SDXL", mode: "image", description: "the unstable models are a collection of checkpoints where limitations cease to exist and creativity knows no limits. This checkpoint defies restrictions and empowers you to generate anything your i..." },
  "unstable-ink-dream": { releaseDate: iso("2022-12-19"), series: "Stable Diffusion", mode: "image", description: "Create a variety of styles including realistic photos, realistic drawings, and animations like last three fig" },
  "urpm": { releaseDate: iso("2022-12-27"), series: "Stable Diffusion", mode: "image", description: "Model for creating photorealistic humans" },
  "vector-art": { releaseDate: iso("2023-01-16"), series: "Stable Diffusion", mode: "image", description: "This is a style model for Stable Diffusion 2.1 mimicking vector style." },
  "wai-ani-nsfw-ponyxl": { releaseDate: iso("2024-04-16"), series: "Pony", mode: "image", description: "WAI-ANI-NSFW-PONYXL is a Pony finetuned for NSFW anime-style generations" },
  "wai-cute-pony": { releaseDate: iso("2024-05-12"), series: "Pony", mode: "image", description: "Anime Pony model, with an emphasis on cute female figures" },
  "waifu-diffusion": { releaseDate: iso("2022-09-14"), series: "Stable Diffusion", mode: "image", description: "Anime styled generations." },
  "western-animation-diffusion": { releaseDate: iso("2023-06-08"), series: "Stable Diffusion", mode: "image", description: "Comicbook and Western Animation Style Model" },
  "white-pony-diffusion-4": { releaseDate: iso("2025-02-01"), series: "Pony", mode: "image", description: "Realistic Pony model with an incredibly strong emphasis on Asian people." },
  "woop-woop-photo": { releaseDate: iso("2023-05-26"), series: "Stable Diffusion", mode: "image", description: "A model trained to make detailed, anatomically-accurate (hands, faces, genitals, etc) illustrations of humans and non-humans alike" },
  "yiffy": { releaseDate: iso("2022-11-01"), series: "Stable Diffusion", mode: "image", description: "Furry styled generations." },
  "zavychromaxl": { releaseDate: iso("2024-06-18"), series: "SDXL", mode: "image", description: "ZavyChromaXL is generalist model with a focus on vibrant colors and detailed renders. It is capable of generating both stylized and realistic images" },
  "zeipher-female-model": { releaseDate: iso("2022-11-07"), series: "Stable Diffusion", mode: "image", description: "For creating images of nude solo women. Also known as f222" },
  // Stability AI / ByteDance SDXL
  "stable-diffusion-xl-base-1.0": {
    releaseDate: iso("2023-07-26"),
    mode: "image",
  },
  "stable-diffusion-xl-lightning": {
    releaseDate: iso("2024-02-21"),
    mode: "image",
  },
  // Lykon DreamShaper (LCM distill of v8)
  "dreamshaper-8-lcm": { releaseDate: iso("2023-12-06"), mode: "image" },
  // Leonardo.Ai
  "lucid-origin": { releaseDate: iso("2025-08-05"), mode: "image" },
  "phoenix-1.0": { releaseDate: iso("2024-08-15"), mode: "image" },

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
  // Kuaishou Kling 3.0 Turbo (t2v/i2v task variants share the base launch).
  "kling-3.0-turbo": { releaseDate: iso("2026-04-15"), mode: "video" },
  // Vidu Q3 Pro (Shengshu). t2v/i2v/start-end task variants share the launch.
  "viduq3-pro": { releaseDate: iso("2026-05-20"), mode: "video" },
  // ByteDance Doubao Seedance 2.0 mini.
  "doubao-seedance-2-0-mini": { releaseDate: iso("2026-06-15"), mode: "video" },
  // MiniMax Hailuo 2.3 fast.
  "minimax-hailuo-2.3-fast": { releaseDate: iso("2025-10-28"), mode: "video" },
  // Alibaba Wan / Tongyi Wanxiang (2.1 Feb 2025; VACE May; 2.2 Jul; 2.5-Preview
  // Sept; 2.6 Dec; 2.7 2026). All modes of a version share that version's launch.
  "wan2.1-i2v-plus": { releaseDate: iso("2025-02-25"), mode: "video" },
  "wan2.1-i2v-turbo": { releaseDate: iso("2025-02-25"), mode: "video" },
  "wan2.1-t2v-plus": { releaseDate: iso("2025-02-25"), mode: "video" },
  "wan2.1-t2v-turbo": { releaseDate: iso("2025-02-25"), mode: "video" },
  "wan2.1-t2i-plus": { releaseDate: iso("2025-02-25"), mode: "image" },
  "wan2.1-t2i-turbo": { releaseDate: iso("2025-02-25"), mode: "image" },
  "wan2.1-vace-plus": { releaseDate: iso("2025-05-14"), mode: "video" },
  "wan2.2-t2v-plus": { releaseDate: iso("2025-07-28"), mode: "video" },
  "wan2.2-i2v-plus": { releaseDate: iso("2025-07-28"), mode: "video" },
  "wan2.2-i2v-flash": { releaseDate: iso("2025-07-28"), mode: "video" },
  "wan2.2-t2i-plus": { releaseDate: iso("2025-07-28"), mode: "image" },
  "wan2.2-t2i-flash": { releaseDate: iso("2025-07-28"), mode: "image" },
  "wan2.2-animate-mix": { releaseDate: iso("2025-07-28"), mode: "video" },
  "wan2.5-i2i": { releaseDate: iso("2025-09-23"), mode: "video" },
  "wan2.5-i2v-preview": { releaseDate: iso("2025-09-23"), mode: "video" },
  "wan2.5-t2v-preview": { releaseDate: iso("2025-09-23"), mode: "video" },
  "wan2.5-t2i-preview": { releaseDate: iso("2025-09-23"), mode: "image" },
  "wan2.6-i2v": { releaseDate: iso("2025-12-16"), mode: "video" },
  "wan2.6-i2v-flash": { releaseDate: iso("2025-12-16"), mode: "video" },
  "wan2.6-r2v": { releaseDate: iso("2025-12-16"), mode: "video" },
  "wan2.6-r2v-flash": { releaseDate: iso("2025-12-16"), mode: "video" },
  "wan2.6-t2v": { releaseDate: iso("2025-12-16"), mode: "video" },
  "wan2.6-t2i": { releaseDate: iso("2025-12-16"), mode: "image" },
  "wan2.6-image": { releaseDate: iso("2025-12-16"), mode: "image" },
  "wan2.7-i2v": { releaseDate: iso("2026-03-10"), mode: "video" },
  "wan2.7-t2v": { releaseDate: iso("2026-03-10"), mode: "video" },
  "wan2.7-image": { releaseDate: iso("2026-04-01"), mode: "image" },
  "wan2.7-image-pro": { releaseDate: iso("2026-04-01"), mode: "image" },
  // Alibaba HappyHorse (Taotian Future Life Lab, on Bailian): 1.0 API test
  // 2026-04-27, 1.1 launch 2026-06-22. r2v/i2v/t2v modes share the version date.
  "happyhorse-1.0-t2v": { releaseDate: iso("2026-04-27"), mode: "video" },
  "happyhorse-1.0-i2v": { releaseDate: iso("2026-04-27"), mode: "video" },
  "happyhorse-1.0-r2v": { releaseDate: iso("2026-04-27"), mode: "video" },
  "happyhorse-1.1-t2v": { releaseDate: iso("2026-06-22"), mode: "video" },
  "happyhorse-1.1-i2v": { releaseDate: iso("2026-06-22"), mode: "video" },
  "happyhorse-1.1-r2v": { releaseDate: iso("2026-06-22"), mode: "video" },
  // Alibaba Qwen-Image (edit 2025-08; edit-plus snapshot 2025-12-15; 2.0 launch 2026-02-10)
  "qwen-image-edit": { releaseDate: iso("2025-08-19"), mode: "image" },
  "qwen-image-edit-plus": { releaseDate: iso("2025-12-15"), mode: "image" },
  "qwen-image-edit-max": { releaseDate: iso("2026-02-10"), mode: "image" },
  "qwen-image-plus": { releaseDate: iso("2025-12-15"), mode: "image" },
  "qwen-image-max": { releaseDate: iso("2026-02-10"), mode: "image" },
  "qwen-image": { releaseDate: iso("2025-08-04"), mode: "image" },
  "qwen-image-2.0": { releaseDate: iso("2026-02-10"), mode: "image" },
  "qwen-image-2.0-pro": { releaseDate: iso("2026-02-10"), mode: "image" },
  // Alibaba text-embedding (Qwen embeddings via DashScope)
  "text-embedding-v3": { releaseDate: iso("2024-12-01") },
  "text-embedding-v4": { releaseDate: iso("2025-05-27") },
  // Alibaba Tongyi Lab Z-Image Turbo (Nov 2025 Apache-2.0 release)
  "z-image-turbo": { releaseDate: iso("2025-11-25"), mode: "image" },
  // Google Veo
  veo3: { releaseDate: iso("2025-05-20"), mode: "video" },
  "veo3-fast": { releaseDate: iso("2025-07-18"), mode: "video" },
  "veo3.1": { releaseDate: iso("2025-10-15"), mode: "video" },
  "veo3.1-pro": { releaseDate: iso("2025-10-15"), mode: "video" },
  // OpenAI Sora 2
  "sora-2": { releaseDate: iso("2025-09-30"), mode: "video" },
  "sora-2-pro": { releaseDate: iso("2025-09-30"), mode: "video" },
  // Kuaishou Kling 2.5 Turbo
  "kling-v2-5-turbo": { releaseDate: iso("2025-09-23"), mode: "video" },
  // MiniMax Hailuo
  "MiniMax-Hailuo-02": { releaseDate: iso("2025-06-18"), mode: "video" },
  "MiniMax-Hailuo-2.3": { releaseDate: iso("2025-10-28"), mode: "video" },
  // Shengshu Vidu Q3
  viduq3: { releaseDate: iso("2026-02-20"), mode: "video" },

  // ─── Audio models (TTS / STT; no context window) ───
  // OpenAI Whisper (whisper-1 = hosted API on large-v2, Mar 2023 launch)
  "whisper-1": { releaseDate: iso("2023-03-01"), mode: "audio" },
  "whisper-large-v3": { releaseDate: iso("2023-11-06"), mode: "audio" },
  "whisper-large-v3-turbo": {
    releaseDate: iso("2024-10-01"),
    mode: "audio",
  },
  // ElevenLabs TTS/STT. text-to-speech task variants share the base launch.
  eleven_monolingual_v1: { releaseDate: iso("2023-01-31"), mode: "audio" },
  eleven_multilingual_v1: { releaseDate: iso("2023-05-08"), mode: "audio" },
  eleven_english_sts_v2: { releaseDate: iso("2023-08-22"), mode: "audio" },
  eleven_multilingual_sts_v2: { releaseDate: iso("2023-08-22"), mode: "audio" },
  eleven_multilingual_v2: { releaseDate: iso("2023-08-22"), mode: "audio" },
  eleven_turbo_v2: { releaseDate: iso("2023-11-30"), mode: "audio" },
  eleven_turbo_v2_5: { releaseDate: iso("2024-07-18"), mode: "audio" },
  eleven_flash_v2: { releaseDate: iso("2024-10-28"), mode: "audio" },
  eleven_flash_v2_5: { releaseDate: iso("2024-10-28"), mode: "audio" },
  eleven_v3: { releaseDate: iso("2025-06-05"), mode: "audio" },
  scribe_v1: { releaseDate: iso("2025-02-27"), mode: "audio" },
  // OpenAI TTS (DevDay launch)
  "tts-1": { releaseDate: iso("2023-11-06"), mode: "audio" },
  "tts-1-hd": { releaseDate: iso("2023-11-06"), mode: "audio" },
  "gpt-4o-mini-tts": { releaseDate: iso("2025-03-20"), mode: "audio" },
  // Alibaba Qwen3-TTS-Flash (earliest cloud snapshot 2025-09-18)
  "qwen3-tts-flash": { releaseDate: iso("2025-09-18"), mode: "audio" },
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
    contextWindow: 8_192,
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
    releaseDate: iso("2025-09-25"),
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
  "grok-4.20-reasoning": {
    releaseDate: iso("2026-03-09"),
    contextWindow: 1_000_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  // net-new SOTA paid adds
  "grok-3": {
    releaseDate: iso("2025-02-17"),
    contextWindow: 131_072,
    series: "Grok",
    supportsTools: true,
  },
  "grok-3-mini": {
    releaseDate: iso("2025-02-17"),
    contextWindow: 131_072,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  "grok-4-0709": {
    releaseDate: iso("2025-07-09"),
    contextWindow: 256_000,
    series: "Grok",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "grok-4.1": {
    releaseDate: iso("2025-11-17"),
    contextWindow: 256_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  "grok-4.2": {
    releaseDate: iso("2026-02-10"),
    contextWindow: 256_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  "o3-pro": {
    releaseDate: iso("2025-06-10"),
    contextWindow: 200_000,
    series: "o3",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "gemini-3-pro-preview": {
    releaseDate: iso("2025-11-18"),
    contextWindow: 1_000_000,
    series: "Gemini",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "gemini-2.5-flash-lite-thinking": {
    releaseDate: iso("2025-06-17"),
    contextWindow: 1_000_000,
    series: "Gemini",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "moonshot-v1-128k": {
    releaseDate: iso("2024-02-01"),
    contextWindow: 131_072,
    series: "Kimi",
    supportsTools: true,
  },
  "qwen3-max-2025-09-23": {
    releaseDate: iso("2025-09-23"),
    contextWindow: 262_144,
    series: "Qwen",
    supportsTools: true,
  },
  // Tencent Hunyuan (T1 reasoning + Turbo S)
  "hunyuan-t1-latest": {
    releaseDate: iso("2025-03-21"),
    contextWindow: 131_072,
    series: "Hunyuan",
    isReasoning: true,
    supportsTools: true,
  },
  "hunyuan-turbos-latest": {
    releaseDate: iso("2025-03-21"),
    contextWindow: 131_072,
    series: "Hunyuan",
    supportsTools: true,
  },
  // Tencent Hunyuan MT2 (machine translation)
  "hy-mt2-plus": {
    releaseDate: iso("2025-09-01"),
    contextWindow: 32_768,
    series: "Hunyuan",
    supportsTools: true,
  },
  // JetBrains Mellum2 (code completion)
  "mellum2-12b-a2.5b-instruct": {
    releaseDate: iso("2026-06-02"),
    contextWindow: 131_072,
    series: "Mellum",
    supportsTools: true,
  },
  // abliteration.ai uncensored model (no official date; approximate)
  "abliterated-model": {
    releaseDate: iso("2025-10-15"),
    contextWindow: 32_768,
    supportsTools: true,
  },
  // Inception Mercury (diffusion LLM)
  "mercury-2": {
    contextWindow: 32_768,
    series: "Mercury",
    supportsTools: true,
  },
  // Aion Labs 2.5 (DeepSeek-based RP/storytelling)
  "aion-2.5": {
    releaseDate: iso("2026-03-10"),
    contextWindow: 131_072,
    series: "Aion",
    supportsTools: true,
  },
  // DeepReinforce Ornith 1.0 35B (RL post-train of Qwen3.5-35B-A3B)
  "ornith-1.0-35b": {
    releaseDate: iso("2026-06-25"),
    contextWindow: 262_144,
    series: "Ornith",
    isReasoning: true,
    supportsTools: true,
  },
  "ornith-1.0-35b-fp8": {
    releaseDate: iso("2026-06-25"),
    contextWindow: 262_144,
    series: "Ornith",
    isReasoning: true,
    supportsTools: true,
  },
  // ByteDance Doubao Seed 1.8 (agentic multimodal, thinking)
  "doubao-seed-1-8-251228": {
    releaseDate: iso("2025-12-28"),
    contextWindow: 262_144,
    series: "Doubao",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // OpenAI gpt-oss 120B (open-weight reasoning MoE)
  "gpt-oss-120b": {
    releaseDate: iso("2025-08-05"),
    contextWindow: 131_072,
    series: "gpt-oss",
    isReasoning: true,
    supportsTools: true,
  },
  // Moonshot Kimi coding (K2 family; preview dates approximate)
  "k2.6-code-preview": {
    releaseDate: iso("2026-05-20"),
    contextWindow: 262_144,
    series: "Kimi",
    isReasoning: true,
    supportsTools: true,
  },
  "kimi-for-coding": {
    releaseDate: iso("2026-04-15"),
    contextWindow: 262_144,
    series: "Kimi",
    isReasoning: true,
    supportsTools: true,
  },
  // Alibaba Qwen3.6 Plus preview (date approximate)
  "qwen3.6-plus-preview": {
    releaseDate: iso("2026-06-10"),
    contextWindow: 262_144,
    series: "Qwen",
    isReasoning: true,
    supportsTools: true,
  },
  // Alibaba Qwen3-Coder 30B-A3B (missing-dash slug)
  "qwen3-coder-30-a3b-instruct": {
    releaseDate: iso("2025-07-31"),
    contextWindow: 262_144,
    series: "Qwen",
    supportsTools: true,
  },
  // Xiaomi MiMo V2 Flash (fast tier, sibling of v2-omni/pro; date approximate)
  "mimo-v2-flash": {
    releaseDate: iso("2026-03-18"),
    contextWindow: 262_144,
    series: "MiMo",
    supportsTools: true,
  },
  // Xiaomi MiMo V2 (Omni multimodal / Pro reasoning)
  "xiaomi-mimo-v2-omni": {
    releaseDate: iso("2026-03-18"),
    contextWindow: 262_144,
    series: "MiMo",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "xiaomi-mimo-v2-pro": {
    releaseDate: iso("2026-03-18"),
    contextWindow: 262_144,
    series: "MiMo",
    isReasoning: true,
    supportsTools: true,
  },
  // Zhipu GLM-4.7 Flash "heretic" (decensored GLM-4.7-Flash)
  "glm-4.7-flash-heretic": {
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  // Obscure uncensored/RP relay finetunes (specs + dates estimated, no official source)
  "devious-uncensored": {
    releaseDate: iso("2025-11-05"),
    contextWindow: 32_768,
    series: "Uncensored",
  },
  "emotional-36b": {
    releaseDate: iso("2025-10-22"),
    contextWindow: 32_768,
    series: "Uncensored",
  },
  "revenant-uncensored": {
    releaseDate: iso("2025-12-10"),
    contextWindow: 32_768,
    series: "Uncensored",
  },
  "grok-uncensored": {
    releaseDate: iso("2025-08-15"),
    contextWindow: 131_072,
    series: "Grok",
  },
  schizogpt: {
    releaseDate: iso("2025-09-18"),
    contextWindow: 32_768,
  },
  umbra: {
    releaseDate: iso("2025-11-20"),
    contextWindow: 32_768,
  },
  // DeepSeek OCR 2 (vision OCR)
  "deepseek-ocr-2": {
    releaseDate: iso("2026-01-27"),
    contextWindow: 8_192,
    series: "DeepSeek",
    supportsVision: true,
  },
  // Baidu ERNIE 4.5 300B (PaddlePaddle serve)
  "ernie-4.5-300b-a47b-paddle": {
    releaseDate: iso("2025-06-30"),
    contextWindow: 131_072,
    series: "ERNIE",
    supportsTools: true,
  },
  // Black Forest Labs FLUX (image gen)
  "flux.1-dev": {
    releaseDate: iso("2024-08-01"),
    series: "FLUX",
  },
  "flux.1-kontext-dev": {
    releaseDate: iso("2025-06-26"),
    series: "FLUX",
  },
  "flux.1-kontext-max": {
    releaseDate: iso("2025-05-29"),
    series: "FLUX",
  },
  "flux.1-kontext-pro": {
    releaseDate: iso("2025-05-29"),
    series: "FLUX",
  },
  // Stability SDXL
  sdxl: {
    releaseDate: iso("2023-07-26"),
    series: "Stable Diffusion",
  },
  // ElevenLabs audio (dubbing + Scribe STT)
  dubbing: {
    releaseDate: iso("2023-10-10"),
    series: "ElevenLabs",
  },
  scribe_v2: {
    releaseDate: iso("2025-11-11"),
    series: "Scribe",
  },
  // Kinfra (TokenHub) embeddings
  "kinfra-text-embedding-0.6b": {
    releaseDate: iso("2026-06-01"),
    contextWindow: 8_192,
    series: "Kinfra",
  },
  "kinfra-text-embedding-4b": {
    releaseDate: iso("2026-06-01"),
    contextWindow: 8_192,
    series: "Kinfra",
  },
  "kinfra-vl-embedding-2b": {
    releaseDate: iso("2026-06-01"),
    contextWindow: 32_768,
    series: "Kinfra",
  },
  "kinfra-vl-embedding-8b": {
    releaseDate: iso("2026-06-01"),
    contextWindow: 32_768,
    series: "Kinfra",
  },
  // Voyage multimodal embedding
  "voyage-multimodal-3.5": {
    releaseDate: iso("2026-01-15"),
    contextWindow: 32_768,
    series: "Voyage",
  },
  // SpeakLeash Bielik (Polish national LLM)
  "bielik-11b-v3.0-instruct": {
    releaseDate: iso("2025-12-30"),
    contextWindow: 32_768,
    series: "Bielik",
  },
  // CYFRAGOVPL PLLuM (Polish government LLM)
  "pllum-12b-instruct": {
    releaseDate: iso("2025-02-01"),
    contextWindow: 131_072,
    series: "PLLuM",
  },
  // VillanovaAI (small preview model)
  "villanova-2b-2512-preview-apnea-ft": {
    releaseDate: iso("2025-12-01"),
    contextWindow: 32_768,
    series: "Villanova",
  },
  // InclusionAI Ling
  "ling-flash-2.0": {
    releaseDate: iso("2025-09-17"),
    contextWindow: 131_072,
    series: "Ling",
    supportsTools: true,
  },
  // ByteDance Seed 2.0 (Doubao Seed 2.0 family, 2026-02-14)
  "seed-2.0-code": {
    releaseDate: iso("2026-02-14"),
    contextWindow: 262_144,
    series: "Seed",
    supportsTools: true,
  },
  "seed-2.0-pro": {
    releaseDate: iso("2026-02-14"),
    contextWindow: 262_144,
    series: "Seed",
    supportsTools: true,
  },
  "seed-1.8": {
    releaseDate: iso("2025-12-28"),
    contextWindow: 262_144,
    series: "Seed",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Sao10K roleplay finetunes (Llama 3 base, HF first-commit dates)
  "sao10k-l3-8b-lunaris-v1": {
    releaseDate: iso("2024-06-26"),
    contextWindow: 8_192,
    series: "Lunaris",
  },
  "sao10k-l3.1-70b-euryale-v2.2": {
    releaseDate: iso("2024-08-28"),
    contextWindow: 32_768,
    series: "Euryale",
  },
  // Alibaba Qwen2 small (Qwen2 series launch 2024-06-06)
  "qwen-2-1.5b-instruct": {
    releaseDate: iso("2024-06-06"),
    contextWindow: 32_768,
    series: "Qwen2",
  },
  // Alibaba Qwen3-VL multimodal thinking (2025-10-21)
  "qwen-3-vl-32b-thinking": {
    releaseDate: iso("2025-10-21"),
    contextWindow: 262_144,
    series: "Qwen3-VL",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Zhipu GLM-4-32B-0414 (2025-04-14; 32K native, served at 128K via YaRN)
  "glm-4-32b": {
    releaseDate: iso("2025-04-14"),
    contextWindow: 131_072,
    series: "GLM",
    supportsTools: true,
  },
  // OpenAI GPT-5.5 with web search tool
  "gpt-5.5-search": {
    releaseDate: iso("2026-04-23"),
    contextWindow: 400_000,
    series: "GPT",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
    supportsWebSearch: true,
  },
  // DeepSeek V4-Flash reasoning variant (date; context already from upstream)
  "deepseek-v4-flash-thinking": {
    releaseDate: iso("2026-04-22"),
    contextWindow: 200_000,
    series: "DeepSeek",
    isReasoning: true,
    supportsTools: true,
  },
  // NavyAI house "laborratse" models (GPT-based; releaseDate from NavyAI
  // /v1/models `created` ts = 2025-06-04. Context ESTIMATED.)
  "gpt-laborratse": {
    releaseDate: iso("2025-06-04"),
    contextWindow: 128_000,
    supportsTools: true,
  },
  "gpt-laborratse-de": {
    releaseDate: iso("2025-06-04"),
    contextWindow: 128_000,
    supportsTools: true,
  },
  "laborratse-uncensored": {
    releaseDate: iso("2025-06-04"),
    contextWindow: 128_000,
  },
  "laborratse-de-uncensored": {
    releaseDate: iso("2025-06-04"),
    contextWindow: 128_000,
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
  // Medium rolling aliases point at Medium 3.5 (2604)
  "mistral-medium": {
    releaseDate: iso("2026-04-28"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "mistral-medium-latest": {
    releaseDate: iso("2026-04-28"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "mistral-medium-3": {
    releaseDate: iso("2025-05-07"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "mistral-medium-3.5": {
    releaseDate: iso("2026-04-28"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "mistral-medium-2604": {
    releaseDate: iso("2026-04-28"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsVision: true,
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
  // Ministral 3 published slugs (ministral-{size}-2512 + -latest aliases)
  "ministral-3b-2512": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "ministral-3b-latest": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "ministral-8b-2512": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "ministral-8b-latest": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "ministral-14b-2512": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "ministral-14b-latest": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsTools: true,
  },
  "mistral-large-3-675b-instruct-2512": {
    releaseDate: iso("2025-12-02"),
    contextWindow: 256_000,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  // Codestral rolling alias (current = 2508, announced Jul 30 2025)
  "codestral-latest": {
    releaseDate: iso("2025-07-30"),
    contextWindow: 256_000,
    series: "Mistral",
    supportsTools: true,
  },
  // Mistral Small dated slugs (2506 = Small 3.2, 2603 = Small 4)
  "mistral-small-2506": {
    releaseDate: iso("2025-06-20"),
    contextWindow: 131_072,
    series: "Mistral",
    supportsVision: true,
    supportsTools: true,
  },
  "mistral-small-2603": {
    releaseDate: iso("2026-03-16"),
    contextWindow: 262_144,
    series: "Mistral",
    supportsVision: true,
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
  "apertus-70b": {
    releaseDate: iso("2025-09-02"),
    contextWindow: 65_536,
    series: "Apertus",
    isReasoning: true,
    supportsTools: true,
  },
  // Regolo house models (Regolo.ai; no public spec, estimated)
  "brick-v1-beta": {
    releaseDate: iso("2026-06-01"),
    contextWindow: 131_072,
    series: "Brick",
    isReasoning: true,
    supportsTools: true,
  },
  "brick-complexity-pro": {
    releaseDate: iso("2026-06-01"),
    contextWindow: 131_072,
    series: "Brick",
    supportsTools: false,
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
  // AI Singapore Qwen-SEA-LION v4.5 27B (Qwen3.6-based, 262K, reasoning)
  "qwen-sea-lion-v4.5-27b-it": {
    releaseDate: iso("2026-02-01"),
    contextWindow: 262_144,
    series: "Qwen",
    isReasoning: true,
  },
  // AI Singapore SEA-LION Embedding Suite (Mar 2026; 512 tuned seq length)
  "sea-lion-e5-embedding-600m": {
    releaseDate: iso("2026-03-01"),
    contextWindow: 512,
    series: "SEA-LION",
  },
  "sea-lion-modernbert-embedding-300m": {
    releaseDate: iso("2026-03-01"),
    contextWindow: 512,
    series: "SEA-LION",
  },
  "sea-lion-modernbert-embedding-600m": {
    releaseDate: iso("2026-03-01"),
    contextWindow: 512,
    series: "SEA-LION",
  },
  // Voyage AI embeddings (32K context)
  "voyage-3": {
    releaseDate: iso("2024-09-18"),
    contextWindow: 32_000,
    series: "Voyage",
  },
  "voyage-3-lite": {
    releaseDate: iso("2024-09-18"),
    contextWindow: 32_000,
    series: "Voyage",
  },
  "voyage-code-3": {
    releaseDate: iso("2024-12-04"),
    contextWindow: 32_000,
    series: "Voyage",
  },
  // OpenCode Zen house coding models (base undisclosed; specs ESTIMATED).
  "big-pickle": {
    releaseDate: iso("2026-01-01"),
    contextWindow: 200_000,
    isReasoning: true,
    supportsTools: true,
  },
  "big-pickle-thinking": {
    releaseDate: iso("2026-01-01"),
    contextWindow: 200_000,
    isReasoning: true,
    supportsTools: true,
  },
  // Z.ai GLM-4.6 Vision Flash
  "glm-4.6v-flash": {
    releaseDate: iso("2025-12-09"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Zhipu GLM-4.1V-9B-Thinking (vision reasoning flash tiers)
  "glm-4.1v-thinking-flash": {
    releaseDate: iso("2025-07-02"),
    contextWindow: 65_536,
    series: "GLM",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "glm-4.1v-thinking-flashx": {
    releaseDate: iso("2025-07-02"),
    contextWindow: 65_536,
    series: "GLM",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // Zhipu GLM-4.7 Flash tier
  "glm-4.7-flash": {
    releaseDate: iso("2025-12-01"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  // Zhipu GLM-5 Turbo
  "glm-5-turbo": {
    releaseDate: iso("2026-01-15"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  // Zhipu GLM-Z1 Air (Z1-0414 reasoning line)
  "glm-z1-air": {
    releaseDate: iso("2025-04-14"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  // Zanity grok-fun: Grok-styled RP finetune (base undisclosed; specs ESTIMATED).
  "grok-fun": {
    releaseDate: iso("2026-01-01"),
    contextWindow: 131_072,
    series: "Grok",
  },
  // OrcaRouter free auto-router meta-models (route to a free upstream; no fixed base/date).
  "orca-router": {
    releaseDate: iso("2026-05-01"),
    contextWindow: 200_000,
    series: "OrcaRouter",
    supportsTools: true,
  },
  "orca-fusion": {
    releaseDate: iso("2026-05-01"),
    contextWindow: 200_000,
    series: "OrcaRouter",
    supportsTools: true,
  },
  "orca-fusion-flash": {
    releaseDate: iso("2026-05-01"),
    contextWindow: 200_000,
    series: "OrcaRouter",
    supportsTools: true,
  },
  "orca-fusion-mini": {
    releaseDate: iso("2026-05-01"),
    contextWindow: 200_000,
    series: "OrcaRouter",
    supportsTools: true,
  },
  // Alibaba Qwen3.5 variants surfaced via mixlayer/llmtr/morph free lanes.
  "qwen3.5-4b": {
    releaseDate: iso("2026-02-23"),
    contextWindow: 262_144,
    series: "Qwen",
    supportsTools: true,
  },
  "qwen3.5-397b": {
    releaseDate: iso("2026-02-23"),
    contextWindow: 262_144,
    series: "Qwen",
    isReasoning: true,
    supportsTools: true,
  },
  "qwen3.5-122b": {
    releaseDate: iso("2026-02-23"),
    contextWindow: 262_144,
    series: "Qwen",
    isReasoning: true,
    supportsTools: true,
  },
  "qwen3.6-27b": {
    releaseDate: iso("2026-05-01"),
    contextWindow: 262_144,
    series: "Qwen",
    isReasoning: true,
    supportsTools: true,
  },
  // Sarvam AI (India sovereign LLM, Indian-language)
  "sarvam-105b": {
    releaseDate: iso("2026-03-01"),
    contextWindow: 131_072,
    series: "Sarvam",
    isReasoning: true,
    supportsTools: true,
  },
  "sarvam-30b": {
    releaseDate: iso("2026-03-01"),
    contextWindow: 131_072,
    series: "Sarvam",
    isReasoning: true,
    supportsTools: true,
  },
  // Typhoon (SCB 10X, Thai-first)
  "typhoon-v2.5-30b-a3b-instruct": {
    releaseDate: iso("2026-01-15"),
    contextWindow: 131_072,
    series: "Typhoon",
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
