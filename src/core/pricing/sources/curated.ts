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
  // Baidu ERNIE. No live source carries these at all, so without an entry the models
  // publish with no date and no context. Figures from Baidu's own docs: the V2 model
  // list (cloud.baidu.com/doc/qianfan/s/rmh4stp0j) for the 5.x/X1.1 line, and the V1
  // per-model pages mirrored at ai.baidu.com/ai-doc/WENXINWORKSHOP for the 3.5/4.0 line.
  // Knowledge cutoffs are deliberately absent: Baidu publishes none for any ERNIE model,
  // relying on an auto-attached Baidu Search plugin instead.
  //
  // The V1 pages never print a single context number. They cap input at "20000 characters
  // and 5120 tokens" and output at [2, 2048], which is what the "-8k" in the name adds up
  // to, so contextWindow is that sum rather than a figure Baidu states outright.
  "ernie-5.0": {
    // Baidu World 2025. The 2.4T technical report is dated 2026-02-06, so GA likely
    // trails the announcement; the announcement date is the one users recognise.
    releaseDate: iso("2025-11-13"),
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    series: "ERNIE",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "ernie-5.0-thinking-preview": {
    releaseDate: iso("2025-11-13"),
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    series: "ERNIE",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "ernie-5.1": {
    // Baidu's blog slug says 0508, the rendered page says May 9.
    releaseDate: iso("2026-05-08"),
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    series: "ERNIE",
    supportsTools: true,
  },
  "ernie-x1.1": {
    // WAVE SUMMIT 2025. 64k, not the 128k the rest of the 5.x line carries.
    releaseDate: iso("2025-09-09"),
    contextWindow: 64_000,
    maxOutputTokens: 65_536,
    series: "ERNIE",
    isReasoning: true,
    supportsTools: true,
  },
  "ernie-3.5-128k": {
    releaseDate: iso("2024-05-16"),
    contextWindow: 128_000,
    series: "ERNIE",
    supportsTools: true,
  },
  "ernie-3.5-8k-preview": {
    releaseDate: iso("2024-10-29"),
    contextWindow: 8_192,
    maxInputTokens: 5_120,
    maxOutputTokens: 2_048,
    series: "ERNIE",
    supportsTools: true,
  },
  "ernie-4.0-8k-latest": {
    releaseDate: iso("2024-06-13"),
    contextWindow: 8_192,
    maxInputTokens: 5_120,
    maxOutputTokens: 2_048,
    series: "ERNIE",
    supportsTools: true,
  },
  "ernie-4.0-8k-preview": {
    releaseDate: iso("2024-05-21"),
    contextWindow: 8_192,
    maxInputTokens: 5_120,
    maxOutputTokens: 2_048,
    series: "ERNIE",
    supportsTools: true,
  },
  "ernie-4.0-turbo-8k-latest": {
    releaseDate: iso("2024-10-11"),
    contextWindow: 8_192,
    maxInputTokens: 5_120,
    maxOutputTokens: 2_048,
    series: "ERNIE",
    supportsTools: true,
  },
  "ernie-4.0-turbo-8k-preview": {
    releaseDate: iso("2024-07-04"),
    contextWindow: 8_192,
    maxInputTokens: 5_120,
    maxOutputTokens: 2_048,
    series: "ERNIE",
    supportsTools: true,
  },
  // Verified release dates (official sources) for models a live source carries
  // dateless, so plain CURATED (gap-fill) can't set them; hard-pin here.
  // Google Nano Banana Pro (Gemini 3 Pro Image Preview), launched 2025-11-20.
  // It reads images as well as writing them, and returns text alongside the
  // image. ai.google.dev/gemini-api/docs/models/gemini-3-pro-image
  "nano-banana-pro-preview": {
    releaseDate: iso("2025-11-20"),
    inputModalities: ["text", "image"],
    outputModalities: ["text", "image"],
    supportsVision: true,
  },
  // OpenAI web-search models, launched with search in the Chat Completions API.
  // The date is in the snapshot id itself (gpt-4o-mini-search-preview-2025-03-11).
  // Sources disagree and one is wrong by four months: relay copies carry
  // 2025-03-12, and one gpt-4o-search-preview row reports 2024-11-20, which
  // predates the model. Override rather than gap-fill so the bad date loses.
  "gpt-4o-search-preview": {
    releaseDate: iso("2025-03-11"),
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    knowledgeCutoff: iso("2023-10-01"),
    series: "GPT",
    supportsWebSearch: true,
  },
  "gpt-4o-mini-search-preview": {
    releaseDate: iso("2025-03-11"),
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    knowledgeCutoff: iso("2023-10-01"),
    series: "GPT",
    supportsWebSearch: true,
  },
  // Nex N2: OpenRouter reports max_completion_tokens == full 262144 context, so
  // an unset max_tokens defaults to the whole window and leaves no room for input
  // (1 in + 262144 out > 262144 -> HTTP 400). Hard-cap output so input fits.
  "nex-n2-pro": { maxOutputTokens: 65_536 },
  "nex-n2-mini": { maxOutputTokens: 65_536 },
  // Sources report 262144, but GLM-5.2 serving stacks enforce max_tokens in
  // [1, 131072] (poloai/tokenreply return HTTP 400 above it).
  "glm-5.2": { maxOutputTokens: 131_072 },
  // Poolside Laguna S 2.1 ships a 1M window; an early OR /models snapshot reported
  // 256K and stuck. Hard-pin the real context.
  // Voted context lands at 131072: that is OpenRouter's single lowest host
  // (Darkbloom), while our lanes serve from Google direct at 262144. Published
  // as "gemma-4-26b" via modelMapping, and this table is an exact-name lookup.
  "gemma-4-26b": {
    releaseDate: iso("2026-04-03"),
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    series: "Gemma",
    supportsVision: true,
    supportsVideo: true,
    supportsTools: true,
  },
  "laguna-s-2.1": { contextWindow: 1_048_576, maxInputTokens: 1_048_576 },
  "laguna-xs-2.1": {
    releaseDate: iso("2026-07-02"),
    contextWindow: 262_144,
    maxInputTokens: 262_144,
  },
  "ling-3.0-flash": {
    releaseDate: iso("2026-07-22"),
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    series: "Ling",
  },
  // Finance-tuned Ling 3.0 Flash.
  "ling-3.0-flash-fin": {
    releaseDate: iso("2026-08-27"),
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    series: "Ling",
  },
  // The model card's config.json caps max_position_embeddings at 131072; the 262144
  // window OpenRouter serves needs the YaRN override (factor 2.0) from the card's own
  // SGLang recipe. Matching what upstream actually serves, as ling-3.0-flash does.
  "ling-3.0-tiny": {
    releaseDate: iso("2026-08-10"),
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 32_768,
    series: "Ling",
    isReasoning: true,
    supportsTools: true,
  },
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
  // litellm reports 1024 for the bare Embed v3 keys, which is the EMBEDDING DIMENSION,
  // not the context length. Cohere's model table gives 512 max tokens for the whole
  // Embed v3 family, and litellm's own bedrock/oci keys for these models agree on 512.
  // (embed-v4.0 really is 128k and is left alone.)
  "embed-english-v3.0": {
    contextWindow: 512,
    maxInputTokens: 512,
    maxOutputTokens: 512,
  },
  "embed-english-light-v3.0": {
    contextWindow: 512,
    maxInputTokens: 512,
    maxOutputTokens: 512,
  },
  "embed-multilingual-v3.0": {
    contextWindow: 512,
    maxInputTokens: 512,
    maxOutputTokens: 512,
  },
  "embed-multilingual-light-v3.0": {
    contextWindow: 512,
    maxInputTokens: 512,
    maxOutputTokens: 512,
  },
  "qwen3-reranker-0.6b": { releaseDate: iso("2025-06-05") },
  "qwen3-reranker-8b": { releaseDate: iso("2025-06-05") },
  "whisper-large-v3": { releaseDate: iso("2023-11-07") },
  "flux.1-schnell": { releaseDate: iso("2024-08-01") },
  "flux-1.1-pro": { releaseDate: iso("2024-10-01") },
  "bge-reranker-v2-m3": { releaseDate: iso("2024-03-18") },
  "rerank-v3.5": { releaseDate: iso("2024-12-02") },
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
  // litellm carries two figures per fast model: xai/* and vertex_ai/xai/* report
  // 2000000 (xAI's real window) while azure_ai/* and oci/* report 131072 (their own
  // deployment caps). The resolver picked the capped variant, so the 2M figure in
  // CURATED never applied - pin it here.
  "grok-4-fast-reasoning": {
    releaseDate: iso("2025-09-19"),
    contextWindow: 2_000_000,
    maxInputTokens: 2_000_000,
  },
  "grok-4-fast-non-reasoning": {
    releaseDate: iso("2025-09-19"),
    contextWindow: 2_000_000,
    maxInputTokens: 2_000_000,
  },
  "grok-4.1-fast-reasoning": {
    releaseDate: iso("2025-11-01"),
    contextWindow: 2_000_000,
    maxInputTokens: 2_000_000,
  },
  "grok-4.1-fast-non-reasoning": {
    releaseDate: iso("2025-11-01"),
    contextWindow: 2_000_000,
    maxInputTokens: 2_000_000,
  },
  "grok-4.5": {
    releaseDate: iso("2026-07-08"),
    contextWindow: 500_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  // Relays report 131072 (and echo it as maxOutputTokens); xAI and OpenRouter both
  // serve the 500K window, same as 4.5.
  "grok-4.6": {
    releaseDate: iso("2026-08-12"),
    contextWindow: 500_000,
    maxInputTokens: 500_000,
    series: "Grok",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // grok.com web reverse. The published names are the proxy's mode names, not
  // xAI model ids, so nothing upstream carries metadata for them and they
  // publish blank without an entry here.
  //
  // Fast mode is Grok 4.5 (confirmed in the web model selector), so it inherits
  // that release and context. isReasoning is deliberately absent: the free tier
  // has no reasoning path at all - Expert/Heavy are SuperGrok-only, and
  // completions come back with reasoning_content empty.
  "grok-chat-fast": {
    releaseDate: iso("2026-07-08"),
    contextWindow: 500_000,
    series: "Grok",
    supportsTools: true,
  },
  // Cognition SWE-1.6, served through the windsurf1 lane. Proprietary and absent
  // from every live pricing source, so it publishes bare without an entry here.
  // Date from Cognition's own post (cognition.com/blog/swe-1-6, dated 04.07.26).
  //
  // supportsTools/isReasoning are corrections, not guesses: the discovered
  // metadata said supportsTools false, but a live call returns real tool_calls
  // (proper call_ ids) AND a populated reasoning_content. Parallel tool calls
  // are the headline change in that release post.
  //
  // Cognition publishes no context window for SWE-1.6 anywhere. 6.4K is what the
  // catalog already carried before this entry and it is preserved rather than
  // replaced, since no better-sourced figure exists to put in its place.
  "swe-1-6-slow": {
    releaseDate: iso("2026-04-07"),
    contextWindow: 6_400,
    series: "SWE",
    supportsTools: true,
    supportsParallelTools: true,
    isReasoning: true,
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

  // Modalities the type-derived fallback in resolver.ts cannot reach: the model
  // type says which side the pipeline routes to, not what the model actually
  // reads or emits. Each verified against the official docs linked per group.

  // Omni models take every modality in and can emit speech, but audio output is
  // opt-in per request (`modalities: ["text","audio"]`), so text is listed first.
  // alibabacloud.com/help/en/model-studio/qwen-omni
  "qwen3.5-omni-flash": {
    inputModalities: ["text", "image", "audio", "video"],
    outputModalities: ["text", "audio"],
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
  },
  "qwen3.5-omni-plus": {
    inputModalities: ["text", "image", "audio", "video"],
    outputModalities: ["text", "audio"],
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
  },
  "qwen-omni-turbo": {
    inputModalities: ["text", "image", "audio", "video"],
    outputModalities: ["text", "audio"],
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
  },

  // Dedicated OCR endpoints: image or PDF in, markdown out. Not chat models, so
  // there is no text prompt modality. docs.z.ai/guides/vlm/glm-ocr
  "glm-ocr": {
    releaseDate: iso("2026-02-03"),
    // Z.AI states practical limits (PDF 50MB/100 pages, image 10MB) rather than
    // a token context for this one, since it is an OCR pipeline and not a chat
    // model; 128K is the figure its model cards carry.
    contextWindow: 131_072,
    series: "GLM",
    inputModalities: ["image", "file"],
    outputModalities: ["text"],
    supportsVision: true,
    supportsPdf: true,
  },
  "deepseek-ocr-2": {
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsVision: true,
  },

  // Full-omni embedders: every modality routes through its own encoder into one
  // vector space. huggingface.co/jinaai/jina-embeddings-v5-omni-nano
  "jina-embeddings-v5-omni-nano": {
    inputModalities: ["text", "image", "audio", "video", "file"],
    outputModalities: ["embedding"],
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    supportsPdf: true,
  },
  "jina-embeddings-v5-omni-small": {
    inputModalities: ["text", "image", "audio", "video", "file"],
    outputModalities: ["embedding"],
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
    supportsPdf: true,
  },
  "llama-nemotron-embed-vl-1b-v2": {
    inputModalities: ["text", "image"],
    outputModalities: ["embedding"],
    supportsVision: true,
  },

  // Classifier, not an image generator: it READS images and returns a category
  // object. The name matches the "moderation" -> image type pattern, which is
  // what published it as image-out. developers.openai.com/api/docs/guides/moderation
  "omni-moderation-latest": {
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsVision: true,
  },

  // Embodied-reasoning models: multimodal in, text out (points, trajectories).
  // ai.google.dev/gemini-api/docs/robotics-overview
  "gemini-robotics-er-1.6-preview": {
    inputModalities: ["text", "image", "audio", "video"],
    outputModalities: ["text"],
  },
  "gemini-robotics-er-2-preview": {
    inputModalities: ["text", "image", "audio", "video"],
    outputModalities: ["text"],
  },

  // Despite the "omni" name this is VIDEO generation, not a speech model: audio
  // exists only as the generated video's soundtrack, and audio input is not yet
  // accepted by the API. ai.google.dev/gemini-api/docs/omni
  "gemini-omni-flash": {
    inputModalities: ["text", "image", "video"],
    outputModalities: ["video"],
    supportsAudio: false,
  },
  "gemini-omni-flash-preview": {
    inputModalities: ["text", "image", "video"],
    outputModalities: ["video"],
    supportsAudio: false,
  },

  "c4ai-aya-vision-32b": {
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsVision: true,
  },
  // Video input is described in Alibaba's announcement but absent from the API
  // reference for this model id, so it is left off. alibabacloud.com/help/en/model-studio/qvq
  "qvq-max": {
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsVision: true,
  },

  // Three lf1 models no live source carries, so without an entry they publish
  // with no vendor, no context and no date.

  // Kiro is AWS's agentic IDE and "auto" is its model-router, not a model:
  // kiro.dev/docs/models/available-models publishes a context window for every
  // concrete model it routes to and NONE for auto, because the request can land
  // on any of them. contextWindow is therefore deliberately absent rather than
  // guessed; any single number for it would be invented.
  "kiro-auto": {
    // ESTIMATE, not a published figure: Kiro documents a context window for
    // every concrete model auto routes to and none for auto itself, since a
    // request can land on any of them. 200K is the floor of that set (GLM-5,
    // and the Claude Sonnet 4.5 class the free tier guarantees); the others go
    // higher, so this understates rather than overstates what a caller gets.
    contextWindow: 200_000,
    // Kiro's own public-preview date (v0.1, kiro.dev/changelog/v0-1-0-preview).
    // Auto itself shipped later and undated, so this is the product's date
    // rather than the router's; without it the row renders no date at all.
    releaseDate: iso("2025-07-14"),
    series: "Kiro",
    isReasoning: true,
    supportsTools: true,
  },
  // M87 Labs (moondream.ai), a 9B MoE vision-language model. The 32K context
  // arrived in Moondream 3 Preview (it was 2K before) and carries into 3.1.
  "moondream3.1": {
    releaseDate: iso("2026-07-07"),
    contextWindow: 32_768,
    series: "Moondream",
    supportsVision: true,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
  },
  // A Qwen3.5-27B finetune from SL-AI, an independent lab. The context is read
  // off the repo's own config.json (max_position_embeddings), not a published
  // claim, and the date is the HF repo creation rather than an announcement.
  "grape-2-pro": {
    releaseDate: iso("2026-04-19"),
    contextWindow: 262_144,
    series: "GRaPE",
    isReasoning: true,
    supportsVision: true,
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
  "lfm-2.5-2.6b": {
    releaseDate: iso("2026-08-11"),
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTools: true,
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
  // Meta Llama 4 (Scout + Maverick), released 2025-04-05.
  "llama-4-maverick-17b-128e-instruct": {
    releaseDate: iso("2025-04-05"),
    series: "Llama",
  },
  "llama-4-scout-17b-16e-instruct": {
    releaseDate: iso("2025-04-05"),
    series: "Llama",
  },
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
  "gemini-robotics-er-2-preview": {
    releaseDate: iso("2026-07-30"),
    contextWindow: 1_048_576,
    series: "Gemini",
    supportsVision: true,
    supportsAudio: true,
    supportsVideo: true,
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
  "nemotron-3-super-120b-a12b": {
    releaseDate: iso("2026-03-11"),
    contextWindow: 1_000_000,
    series: "Nemotron",
  },
  "nemotron-3-ultra-550b-a55b": {
    releaseDate: iso("2026-06-04"),
    contextWindow: 262_144,
    series: "Nemotron",
  },
  // Safety classifier, not a chat model: it grades content rather than answering.
  "nemotron-3.5-content-safety": {
    releaseDate: iso("2026-06-04"),
    contextWindow: 128_000,
    series: "Nemotron",
    supportsVision: true,
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
  // Agnes 2.5 + async image/video lanes (provider publishes no dates; estimated)
  "agnes-2.5-flash": {
    releaseDate: iso("2026-07-01"),
    contextWindow: 262_144,
    series: "Agnes",
    supportsVision: true,
    supportsTools: true,
  },
  "agnes-image-2.0-flash": {
    releaseDate: iso("2026-06-01"),
    series: "Agnes",
    mode: "image",
  },
  "agnes-image-2.1-flash": {
    releaseDate: iso("2026-07-01"),
    series: "Agnes",
    mode: "image",
  },
  "agnes-video-v2.0": {
    releaseDate: iso("2026-06-01"),
    series: "Agnes",
    mode: "video",
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
  // 6.8 Flash Lite preview, the multimodal AGENT model of the line: SenseTime
  // pitches it at autonomous planning over hundreds of steps rather than single
  // answers. Context is unpublished for it too, so it inherits the flash line's
  // 128K rather than claiming a figure nobody states.
  // Swiss AI Initiative (ETH + EPFL). v1.5 is a bigger jump than the name: it
  // added vision, an opt-in thinking mode and tools, and quadrupled context to
  // 256K from v1.0's 64K.
  "apertus-v1.5-70b": {
    releaseDate: iso("2026-07-24"),
    contextWindow: 262_144,
    series: "Apertus",
    isReasoning: true,
    supportsTools: true,
    supportsVision: true,
  },
  // Cohere Labs Tiny Aya, one family launched together at the India AI Summit.
  // The four are region-specialised merges of the same 3.35B base rather than
  // separate trainings: earth = West Asian + African, fire = South Asian,
  // water = European + Asia-Pacific, global = balanced.
  "tiny-aya-earth": {
    releaseDate: iso("2026-02-17"),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    series: "Aya",
  },
  "tiny-aya-fire": {
    releaseDate: iso("2026-02-17"),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    series: "Aya",
  },
  "tiny-aya-water": {
    releaseDate: iso("2026-02-17"),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    series: "Aya",
  },
  "tiny-aya-global": {
    releaseDate: iso("2026-02-17"),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    series: "Aya",
  },
  // The moonshot-v1 line all debuted with the open platform's public beta, so
  // they share that date the way the existing 128k entry does.
  "moonshot-v1-8k": {
    releaseDate: iso("2024-02-01"),
    contextWindow: 8_192,
    series: "Kimi",
    supportsTools: true,
  },
  "moonshot-v1-32k": {
    releaseDate: iso("2024-02-01"),
    contextWindow: 32_768,
    series: "Kimi",
    supportsTools: true,
  },
  // The vision variants came later and take base64 or an uploaded file id, not
  // an image URL.
  "moonshot-v1-32k-vision-preview": {
    releaseDate: iso("2025-01-15"),
    contextWindow: 32_768,
    series: "Kimi",
    supportsTools: true,
    supportsVision: true,
  },
  // The id encodes 20241022 but general availability was 2024-11-04, which is
  // what the Bedrock and Vertex cards carry.
  "claude-3-5-haiku-20241022": {
    releaseDate: iso("2024-11-04"),
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    series: "Claude",
    supportsTools: true,
    supportsVision: true,
  },
  "sensenova-6.8-flash-lite": {
    releaseDate: iso("2026-08-11"),
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
    releaseDate: iso("2026-06-08"),
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    series: "Nex N2",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "nex-n2-mini": {
    releaseDate: iso("2026-06-24"),
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
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
  "llama-3.2-11b-vision": {
    releaseDate: iso("2024-09-25"),
    contextWindow: 131_072,
    series: "Llama",
    supportsVision: true,
    supportsTools: true,
  },
  // Meta Llama Prompt Guard 2 (jailbreak classifiers, LlamaCon launch)
  "llama-prompt-guard-2-22m": {
    releaseDate: iso("2025-04-29"),
    series: "Llama",
  },
  "llama-prompt-guard-2-86m": {
    releaseDate: iso("2025-04-29"),
    series: "Llama",
  },
  // NVIDIA Nemotron Super 49B (Llama 3.3 distill; v1 GTC, v1.5 July refresh)
  // Relay spells it 3.3.70b (dot, not dash), which matches no source entry.
  "llama-3.3.70b-instruct": {
    releaseDate: iso("2024-12-06"),
    contextWindow: 131_072,
    series: "Llama",
    supportsTools: true,
  },
  "llama-3.3-nemotron-super-49b-v1": {
    releaseDate: iso("2025-03-18"),
    series: "Nemotron",
  },
  "llama-3.3-nemotron-super-49b-v1.5": {
    releaseDate: iso("2025-07-25"),
    series: "Nemotron",
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
  // FLUX.2 launch wave (pro/flex/dev/max), announced together 2025-11-25. Both
  // spellings per model: relays publish dotted and hyphenated names and the
  // lookup is exact.
  "flux.2-flex": {
    releaseDate: iso("2025-11-25"),
    series: "FLUX",
    mode: "image",
  },
  "flux-2-flex": {
    releaseDate: iso("2025-11-25"),
    series: "FLUX",
    mode: "image",
  },
  "flux.2-pro": {
    releaseDate: iso("2025-11-25"),
    series: "FLUX",
    mode: "image",
  },
  "flux-2-pro": {
    releaseDate: iso("2025-11-25"),
    series: "FLUX",
    mode: "image",
  },
  "flux.2-dev": {
    releaseDate: iso("2025-11-25"),
    series: "FLUX",
    mode: "image",
    description:
      "FLUX.2 [dev], a 32B flow-matching transformer for generating and editing multiple images.",
  },
  // Hyphen spelling: logfare publishes flux-2-dev, which never matched the dotted key.
  "flux-2-dev": {
    releaseDate: iso("2025-11-25"),
    series: "FLUX",
    mode: "image",
    description:
      "FLUX.2 [dev], a 32B flow-matching transformer for generating and editing multiple images.",
  },
  "flux.2-max": {
    releaseDate: iso("2025-11-25"),
    series: "FLUX",
    mode: "image",
  },
  // FLUX.2 [klein], distilled 4B/9B variants, released 2026-01-15.
  "flux.2-klein-4b": {
    releaseDate: iso("2026-01-15"),
    series: "FLUX",
    mode: "image",
  },
  "flux.2-klein-9b": {
    releaseDate: iso("2026-01-15"),
    series: "FLUX",
    mode: "image",
  },
  "flux-kontext-max": { releaseDate: iso("2025-05-29"), mode: "image" },
  "flux-dev": { releaseDate: iso("2024-08-01"), mode: "image" },
  // FLUX.1 [dev] served over Runware; the suffix keeps it distinct from the entry
  // above, which fuzzy-matches the text FLUX and picks up a context window.
  "flux-1-dev-runware": {
    releaseDate: iso("2024-08-01"),
    series: "FLUX",
    mode: "image",
    description:
      "FLUX.1 [dev], a 12B rectified-flow transformer for high prompt-adherence text-to-image.",
  },
  "flux.1-schnell": { releaseDate: iso("2024-08-01"), mode: "image" },
  // Zhipu image (chatglm.cn guest lane). The -250304 suffix is 6 digits, so no
  // DATE_SUFFIX_PATTERN strips it and the bare name keeps it.
  "cogview-4-250304": {
    releaseDate: iso("2025-03-04"),
    series: "GLM",
    mode: "image",
  },
  "glm-image-1": {
    releaseDate: iso("2026-01-13"),
    series: "GLM",
    mode: "image",
  },
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
  // Dates below are each version's Civitai publishedAt for the exact version id the
  // Runware channel pins, so they describe the weights actually served rather than
  // the first release of the model family.
  "juggernaut-xl": {
    releaseDate: iso("2024-08-29"),
    series: "SDXL",
    mode: "image",
    description:
      "Photorealistic SDXL merge tuned for portraits, cinematic lighting and product shots.",
  },
  "wai-nsfw-illustrious-sdxl": {
    releaseDate: iso("2025-05-08"),
    series: "Illustrious",
    mode: "image",
    description:
      "Illustrious-based anime checkpoint with strong character knowledge and booru-style tag prompting.",
  },
  "pony-realism": {
    releaseDate: iso("2024-10-02"),
    series: "Pony",
    mode: "image",
    description:
      "Pony-based checkpoint aimed at photorealistic output while keeping Pony's prompt understanding.",
  },
  "nova-anime-xl": {
    releaseDate: iso("2024-09-01"),
    series: "Pony",
    mode: "image",
  },
  // Runware Civitai checkpoints. No upstream pricing source lists community
  // checkpoints, so without these they render dateless and undescribed.
  // NVIDIA build.nvidia.com models no upstream source carries: the NIM /v1/models
  // response returns only id + owned_by (its `created` is a constant stub), so context
  // and dates come from each model's HuggingFace card config.json.
  "nemotron-3.5-lightning-30b-a3b": {
    releaseDate: iso("2026-08-01"),
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    series: "Nemotron",
    isReasoning: true,
    supportsTools: true,
  },
  "nemotron-3-embed-1b": {
    releaseDate: iso("2026-07-14"),
    contextWindow: 262_144,
    mode: "embedding",
  },
  // OpenRouter's alias for the 30b-a3b build; it serves 1M on the free lane.
  "nemotron-3.5-lightning": {
    releaseDate: iso("2026-08-01"),
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
    series: "Nemotron",
    isReasoning: true,
    supportsTools: true,
  },
  // gemma-4-31b derivative, image-text-to-text.
  "ising-calibration-1.5-31b": {
    releaseDate: iso("2026-07-13"),
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    supportsVision: true,
  },
  "riva-translate-4b-instruct-v2": {
    releaseDate: iso("2026-04-15"),
    contextWindow: 8_192,
    maxInputTokens: 8_192,
  },
  // Meta Superintelligence Labs, distilled from Muse Spark. Multimodal.
  "muse-glimmer-30b": {
    releaseDate: iso("2026-08-09"),
    contextWindow: 131_072,
    maxInputTokens: 131_072,
    series: "Muse",
    supportsVision: true,
    supportsTools: true,
  },
  // Thinking Machines Lab MoE: 41B active of 975B. The :batch and -small variants
  // report 512K; the base lane is 1M.
  inkling: {
    releaseDate: iso("2026-07-17"),
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 262_144,
    series: "Inkling",
    supportsVision: true,
    supportsAudio: true,
    supportsTools: true,
  },
  "inkling-small": {
    releaseDate: iso("2026-07-30"),
    contextWindow: 524_288,
    maxInputTokens: 524_288,
    maxOutputTokens: 262_144,
    series: "Inkling",
    supportsVision: true,
    supportsTools: true,
  },
  // Passthrough lane: the checkpoint is chosen per request, so it has no single
  // release date or architecture to report.
  "custom-civitai": {
    mode: "image",
    series: "Civitai",
    description:
      "Passthrough lane for any Civitai checkpoint: paste a model URL and it renders on that checkpoint.",
  },
  "anything-xl": {
    releaseDate: iso("2024-03-10"),
    series: "SDXL",
    mode: "image",
    description:
      "Anime-oriented SDXL merge (Anything XL) covering illustration and character art.",
  },
  "autismmix-sdxl": {
    releaseDate: iso("2024-02-02"),
    series: "Pony",
    mode: "image",
    description:
      "Pony-based anime merge favouring clean linework and consistent character rendering.",
  },
  "dreamshaper-v8": {
    releaseDate: iso("2023-07-29"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "General-purpose SD 1.5 merge covering photoreal, art and illustration styles.",
  },
  "dreamshaper-xl": {
    releaseDate: iso("2023-07-26"),
    series: "SDXL",
    mode: "image",
    description: "SDXL edition of DreamShaper, a broad general-purpose merge.",
  },
  epicrealism: {
    releaseDate: iso("2023-08-22"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "SD 1.5 photorealism checkpoint (Natural Sin) tuned for skin detail and natural light.",
  },
  "hassaku-xl-illustrious": {
    releaseDate: iso("2025-04-03"),
    series: "Illustrious",
    mode: "image",
    description:
      "Illustrious-based anime checkpoint with a bold, high-contrast style.",
  },
  "majicmix-realistic": {
    releaseDate: iso("2023-10-05"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "SD 1.5 realism merge best known for East Asian portrait photography.",
  },
  "nova-furry-xl": {
    releaseDate: iso("2025-02-11"),
    series: "Illustrious",
    mode: "image",
    description:
      "Illustrious-based checkpoint specialising in anthro and furry character art.",
  },
  // Civitai reports publishedAt 2026-04-29 for version 290640, but that is a later
  // re-publish: its sibling versions date to January 2024 and Pony V6 XL shipped
  // then. Pinned to the real release so it does not sort as the newest model.
  "pony-diffusion-v6-xl": {
    releaseDate: iso("2024-01-07"),
    series: "Pony",
    mode: "image",
    description:
      "The Pony base checkpoint, tuned for prompt adherence and character control via score tags.",
  },
  "realistic-vision-v6": {
    releaseDate: iso("2023-07-31"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "SD 1.5 photorealism checkpoint aimed at portraits and lifelike detail.",
  },
  "nova-furry-pony": {
    releaseDate: iso("2024-10-01"),
    series: "Pony",
    mode: "image",
  },
  // AI Horde full image catalog (auto-generated from AI-Horde-image-model-reference)
  "albedobase-xl-31": {
    releaseDate: iso("2023-09-05"),
    series: "SDXL",
    mode: "image",
    description:
      "SDXL Model that doesn't require a refiner. This is the 3.1 version.",
  },
  "albedobase-xl-sdxl": {
    releaseDate: iso("2023-09-05"),
    series: "SDXL",
    mode: "image",
    description: "SDXL Model that doesn't require a refiner.",
  },
  "icbinp-i-cant-believe-its-not-photography": {
    releaseDate: iso("2023-04-02"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "Following on from Gorilla With A Brick, merged in 10 more photorealistic models at various weights, and some more noise offset to create something that when prompted for photorealism will make you ...",
  },
  absolutereality: {
    releaseDate: iso("2023-05-31"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "That feeling when you wake up after a dream.  This is a fantastic sd1.5 realism bought to you by the creator of DreamShaper",
  },
  dreamshaper: {
    releaseDate: iso("2023-01-12"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "Merged model mix of Midnight mixer, roboEtics, f222, elldrethSLucidMix, Seek.ART Mega, rpg, hassanBlend, modelshoot and roboDiffusion",
  },
  "rev-animated": {
    releaseDate: iso("2023-04-16"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "This model is mainly intended for Portraits and Full Body Anime-like pictures. Fantasy landscapes are decent.",
  },
  "cyberrealistic-pony": {
    releaseDate: iso("2025-03-01"),
    series: "Pony",
    mode: "image",
    description:
      "Cyberrealistic Pony is a semi-realistic Pony model capable of SFW and NSFW portraits as well as scenery.",
  },
  "anything-v5": {
    releaseDate: iso("2023-02-16"),
    series: "Stable Diffusion",
    mode: "image",
    description: "Anything V5, see the project homepage",
  },
  amponyxl: {
    releaseDate: iso("2024-02-02"),
    series: "Pony",
    mode: "image",
    description:
      "Anime model based on Pony Diffusion XL - remember to use the score prompts to get this to go properly",
  },
  "prefect-pony": {
    releaseDate: iso("2024-05-06"),
    series: "Pony",
    mode: "image",
    description: "Anime Pony model with an emphasis on NSFW and LoRA support",
  },
  "flat-2d-animerge": {
    releaseDate: iso("2023-04-10"),
    series: "Stable Diffusion",
    mode: "image",
    description:
      "This is a merge of some random anime based and cartoon based models to achieve a somewhat cartoony anime style, more similar to what you would actually see in anime as opposed to the more common hy...",
  },
  "quiet-goodnight-xl": {
    releaseDate: iso("2024-03-05"),
    series: "SDXL",
    mode: "image",
    description: "SDXL Model for anime, bought to you from the maker of ICBINP",
  },
  "tunix-pony": {
    releaseDate: iso("2024-07-05"),
    series: "Pony",
    mode: "image",
    description: "Semi-realistic stylized PonyXL finetune",
  },
  fustercluck: {
    releaseDate: iso("2023-12-12"),
    series: "SDXL",
    mode: "image",
    description:
      "SDXL Model for cartoony style. If it's not cartoony enough, you may need to add 'anime, cartoon' to the front of the positive prompt to push the image in the right direction",
  },
  swamponyxl: {
    releaseDate: iso("2024-04-23"),
    series: "Pony",
    mode: "image",
    description:
      "Realistic finetune of Pony Diffusion V6, with an emphasis on asian likeness.",
  },
  "wai-cute-pony": {
    releaseDate: iso("2024-05-12"),
    series: "Pony",
    mode: "image",
    description: "Anime Pony model, with an emphasis on cute female figures",
  },
  "ntr-mix-il-noob-xl": {
    releaseDate: iso("2024-11-07"),
    series: "SDXL",
    mode: "image",
    description:
      "NTR Mix Illustrious Noob XL is a anime model that can generate stylized anime images, both SFW and NSFW. It can generate both singular portraits and images with multiple characters in them.",
  },
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
  // Preview 2026-05-31, GA 2026-06-16. Adds text-to-video and reference-to-video
  // on top of i2v, native 1080p. Billed per second upstream.
  "grok-imagine-video-1.5": { releaseDate: iso("2026-06-16"), mode: "video" },
  // "grok-video-3" is pol's own name: xAI ships no such model (their line is
  // grok-imagine-video / -1.5). Kept typed as video so it routes correctly, but
  // no release date or spec is asserted, because there is no upstream to cite.
  "grok-video-3": { mode: "video" },
  // Grok Imagine image, via the grok.com web reverse. Same feature launch as the
  // video model; "-lite" is the free tier's variant, and it is the only Imagine
  // model a free account is entitled to.
  "grok-imagine-image-lite": { releaseDate: iso("2025-08-07"), mode: "image" },
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
  "veo3.1-fast": { releaseDate: iso("2025-10-15"), mode: "video" },
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
  // Duplicate of embed-multilingual-v3.0 under the vendor-prefixed id. toBareName
  // keeps a `cohere-` prefix (it is not a known host/org prefix it strips), so the
  // unprefixed key above never matches the published cohere-embed-* name.
  "cohere-embed-multilingual-v3.0": {
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
  // MiniMax M2.5 highspeed (aigc serving variant of M2.5, upstream carries no date)
  "minimax-m2.5-highspeed": {
    releaseDate: iso("2026-02-12"),
    contextWindow: 204_800,
    maxOutputTokens: 196_608,
    isReasoning: true,
    supportsTools: true,
  },
  "minimax-m2.7": {
    releaseDate: iso("2026-03-18"),
    contextWindow: 204_800,
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
  // Combined fast aliases (single published name covering both effort lanes)
  "grok-4.1-fast": {
    releaseDate: iso("2025-11-01"),
    contextWindow: 2_000_000,
    series: "Grok",
    isReasoning: true,
    supportsTools: true,
  },
  "grok-4.20-fast": {
    releaseDate: iso("2026-03-31"),
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
  // Kimi K2.6 rebrand slugs (no "k" prefix) + coding-lane K3 alias
  "kimi-2.6": {
    releaseDate: iso("2026-04-20"),
    contextWindow: 262_144,
    series: "Kimi",
    isReasoning: true,
    supportsTools: true,
  },
  "kimi-2.6-thinking": {
    releaseDate: iso("2026-04-20"),
    contextWindow: 262_144,
    series: "Kimi",
    isReasoning: true,
    supportsTools: true,
  },
  "coding-kimi-k3-free": {
    releaseDate: iso("2026-07-16"),
    contextWindow: 1_000_000,
    series: "Kimi",
    isReasoning: true,
    supportsTools: true,
  },
  // Relay-side aliases for Kimi K3. Neither strips to a name any source carries, so
  // without these they resolve to nothing at all.
  k3: {
    releaseDate: iso("2026-07-16"),
    contextWindow: 1_000_000,
    series: "Kimi",
    isReasoning: true,
    supportsTools: true,
  },
  "kimi-for-coding-highspeed": {
    releaseDate: iso("2026-07-16"),
    contextWindow: 1_000_000,
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
  // z.ai-branded GLM-4.7 thinking lane (same weights as glm-4.7)
  "zai-glm-4.7-thinking": {
    releaseDate: iso("2025-12-22"),
    series: "GLM",
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
  "deepseek-v4-pro-thinking": {
    releaseDate: iso("2026-04-24"),
    contextWindow: 1_000_000,
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
  // Original Codestral 22B (bare slug, no source carries a date)
  codestral: {
    releaseDate: iso("2024-05-29"),
    contextWindow: 32_000,
    series: "Mistral",
    supportsTools: true,
  },
  // Ministral 3B (Les Ministraux launch; bare slug distinct from 2512 refresh)
  "ministral-3b": {
    releaseDate: iso("2024-10-16"),
    contextWindow: 131_072,
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
  // Dots Studio Dots3-Note Preview (MoE, 16B active of 280B; lightest of Dots 3)
  "dots-3-note-preview": {
    releaseDate: iso("2026-08-12"),
    contextWindow: 512_000,
    maxOutputTokens: 512_000,
    series: "Dots",
    isReasoning: true,
    supportsTools: true,
    supportsVision: true,
  },
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
  "gemma-4-e2b": {
    releaseDate: iso("2026-03-31"),
    contextWindow: 131_072,
    series: "Gemma",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  "gemma-4-31b-it": {
    releaseDate: iso("2026-04-02"),
    contextWindow: 262_144,
    series: "Gemma",
    supportsVision: true,
    supportsVideo: true,
    supportsTools: true,
  },
  // Rolling aliases (track current GA: 2.5 Pro / Mistral Code launch)
  "gemini-pro-latest": {
    releaseDate: iso("2025-06-17"),
  },
  "mistral-code-latest": {
    releaseDate: iso("2025-06-04"),
    series: "Mistral",
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
  // Stealth model behind OpenCode Zen's x-preview-f and OpenRouter's stealth/
  // namespace; specs are OpenRouter's published ones, not estimates.
  "ox-alpha": {
    releaseDate: iso("2026-08-20"),
    contextWindow: 1_048_576,
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
  // Zhipu legacy GLM-4 line, served free by the chatglm.cn guest lane. No live
  // source carries these (they predate OpenRouter's GLM listings and Zhipu retired
  // most of them from the paid catalog), so they publish dateless and contextless
  // without this block. Dates + windows from the bigmodel.cn model cards.
  "glm-4": {
    releaseDate: iso("2024-01-16"),
    contextWindow: 128_000,
    series: "GLM",
  },
  "glm-4-air": {
    releaseDate: iso("2024-06-05"),
    contextWindow: 128_000,
    series: "GLM",
  },
  "glm-4v": {
    releaseDate: iso("2024-01-16"),
    contextWindow: 8_192,
    series: "GLM",
    supportsVision: true,
  },
  // The 0414 line: GLM-4-Flash/FlashX refreshed 2025-04-14 alongside GLM-Z1.
  "glm-4-flash-250414": {
    releaseDate: iso("2025-04-14"),
    contextWindow: 128_000,
    series: "GLM",
    supportsTools: true,
  },
  "glm-4-flashx-250414": {
    releaseDate: iso("2025-04-14"),
    contextWindow: 128_000,
    series: "GLM",
    supportsTools: true,
  },
  // First Zhipu RL reasoning model, launched 2024-12-31. 16K window, not the 8K
  // that fuzzy-matching to glm-4v-9b would suggest.
  "glm-zero-preview": {
    releaseDate: iso("2024-12-31"),
    contextWindow: 16_000,
    series: "GLM",
    isReasoning: true,
  },
  // Agentic research model: runs a search/browse loop rather than a plain chat turn.
  "glm-deep-research": {
    releaseDate: iso("2025-03-21"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  "glm-5v-turbo": {
    releaseDate: iso("2026-01-15"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsVision: true,
    supportsTools: true,
  },
  // A "<model>-<tier>-thinking" name cannot fuzzy-match its own base: the base ends
  // in a TIER_SUFFIX (-air/-flash/-turbo) and the -thinking name does not, so
  // tierSuffixMismatch rejects the candidate before similarity is scored. Names
  // without a tier suffix (glm-4.7-thinking -> glm-4.7) resolve fine. Pin the
  // affected variants to their base's specs.
  "glm-4-air-thinking": {
    releaseDate: iso("2024-06-05"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
  },
  "glm-4-flash-thinking": {
    releaseDate: iso("2025-08-26"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
  },
  "glm-5-turbo-thinking": {
    releaseDate: iso("2026-01-15"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsTools: true,
  },
  "glm-5v-turbo-thinking": {
    releaseDate: iso("2026-01-15"),
    contextWindow: 128_000,
    series: "GLM",
    isReasoning: true,
    supportsVision: true,
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
