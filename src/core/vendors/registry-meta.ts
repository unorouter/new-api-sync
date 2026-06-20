// Single source of truth for simple OpenAI-compatible free-tier providers.
// Zero runtime deps so the web bundle can import it. Adding a provider = one entry
// here + one discovery module wired in registry.ts.

export interface SimpleProviderMeta {
  kind: string;
  label: string;
  defaultBaseUrl: string;
  defaultRatio: number;
  apiKeyPlaceholder: string;
  /** new-api channel type for test + emit. Omit for OPENAI (1). Z.ai = ZHIPU_V4 (26). */
  channelType?: number;
  /** If set, the provider's image models are emitted with this channel type
   *  (native image surface). Omit to skip image models. Cloudflare = CLOUDFLARE (39). */
  imageChannelType?: number;
  /** If set, audio models (STT/TTS) are emitted with this channel type. Omit to
   *  skip audio. Groq = OPENAI (1), Cloudflare = CLOUDFLARE (39). */
  audioChannelType?: number;
  /** Keep models that probe-fail with a 429 (Cloudflare: the shared 10k-neuron/day
   *  cap 429s every model once spent, but they are valid free models, so a sync
   *  while exhausted must not drop them). Only safe where 429 = capacity, not breakage. */
  acceptRateLimited?: boolean;
}

export const SIMPLE_PROVIDER_META = [
  {
    kind: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai",
    defaultRatio: 0,
    apiKeyPlaceholder: "gsk_…",
    audioChannelType: 1,
  },
  {
    kind: "gemini",
    label: "Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultRatio: 0,
    apiKeyPlaceholder: "AIza… / AQ.…",
  },
  {
    kind: "cerebras",
    label: "Cerebras",
    defaultBaseUrl: "https://api.cerebras.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "csk-…",
  },
  {
    kind: "sambanova",
    label: "SambaNova",
    defaultBaseUrl: "https://api.sambanova.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "uuid key",
  },
  {
    kind: "mistral",
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "mistral key",
  },
  {
    kind: "cloudflare",
    label: "Cloudflare",
    // Per-account: replace {account_id}. Base ends at "/ai" (no /v1); the runner
    // and new-api append /v1/chat/completions, discovery appends /models/search.
    defaultBaseUrl:
      "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "cf-... (Workers AI token)",
    imageChannelType: 39,
    audioChannelType: 39,
    acceptRateLimited: true,
  },
  {
    kind: "github",
    label: "GitHub",
    // Base ends at "/inference"; discovery strips it and appends /catalog/models.
    defaultBaseUrl: "https://models.github.ai/inference",
    defaultRatio: 0,
    apiKeyPlaceholder: "github_pat_... (models:read)",
  },
  {
    kind: "ovh",
    label: "OVHcloud",
    // Anonymous OpenAI-compatible endpoint (no key needed; placeholder sent).
    // Base is the host; runner + discovery append /v1. All modalities are
    // OpenAI-shaped (image /v1/images/generations, audio /v1/audio/*), so
    // image/audio route through the OPENAI channel type (1).
    defaultBaseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net",
    defaultRatio: 0,
    apiKeyPlaceholder: "IAM JWT PAT",
    imageChannelType: 1,
    audioChannelType: 1,
  },
  {
    kind: "aihorde",
    label: "AI Horde",
    // Anonymous key (0000000000), lowest queue priority. OpenAI-compat text-only
    // proxy; base is the host, runner appends /v1. Volunteer-hosted -> slow +
    // intermittent; the only pooling-legal source. Curated RP models in discovery.
    defaultBaseUrl: "https://oai.aihorde.net",
    defaultRatio: 0,
    apiKeyPlaceholder: "0000000000 (anon)",
  },
  {
    kind: "pollinations",
    label: "Pollinations",
    // Unified OpenAI-compatible endpoint (gen.pollinations.ai); base is the host,
    // runner + discovery append /v1. Free Seed-tier models only (premium Pollen
    // models filtered in discovery). Image/audio are OpenAI-shaped -> OPENAI type.
    defaultBaseUrl: "https://gen.pollinations.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk_...",
    imageChannelType: 1,
    audioChannelType: 1,
  },
  {
    kind: "cohere",
    label: "Cohere",
    // OpenAI-compatibility layer; base ends at "/compatibility", runner + discovery
    // append /v1. Trial key serves chat + embeddings free (rate-limited, 1000/mo).
    defaultBaseUrl: "https://api.cohere.ai/compatibility",
    defaultRatio: 0,
    apiKeyPlaceholder: "cohere trial key",
  },
  {
    kind: "jina",
    label: "Jina AI",
    // Host only; runner + discovery append /v1. Embedding-only provider: the
    // helper's embedding modality probes /v1/embeddings. 10M free tokens per key.
    defaultBaseUrl: "https://api.jina.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "jina_...",
  },
  {
    kind: "llm7",
    label: "LLM7",
    // Free OpenAI-compat gateway (api.llm7.io/v1); base is the host, runner +
    // discovery append /v1. A free token (token.llm7.io, Google login) lifts the
    // keyless throttle to 5M tokens/day. /v1/models returns a bare array. ~6 models.
    defaultBaseUrl: "https://api.llm7.io",
    defaultRatio: 0,
    apiKeyPlaceholder: "llm7 token",
  },
  {
    kind: "siliconflow",
    label: "SiliconFlow",
    // OpenAI-compatible; base is the host, runner + discovery append /v1. Pay-per-
    // token (Y14 signup credit), but exposed free here. Image models (FLUX.2,
    // Z-Image) are OpenAI-shaped -> OPENAI channel type (1).
    defaultBaseUrl: "https://api.siliconflow.com",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk-...",
    imageChannelType: 1,
  },
  {
    kind: "huggingface",
    label: "HuggingFace",
    // OpenAI-compatible router; base is the host, runner + discovery append /v1.
    // One key fans out to deepinfra/nebius/novita/together/fireworks/scaleway/...
    // (HF auto-picks the fastest live provider per model). Monthly free credits.
    defaultBaseUrl: "https://router.huggingface.co",
    defaultRatio: 0,
    apiKeyPlaceholder: "hf_...",
  },
  {
    kind: "ionet",
    label: "io.net",
    // Decentralized GPU inference. Base ends at "/api" so the runner + discovery append
    // /v1 -> /api/v1/chat/completions + /api/v1/models. Free tier, ~29 frontier models
    // (DeepSeek-V4, Kimi-K2.x, GLM, MiniMax, Qwen3.x, Llama-4, gpt-oss). API keys expire
    // ~180 days (rotate). Email-OTP signup, no card.
    defaultBaseUrl: "https://api.intelligence.io.solutions/api",
    defaultRatio: 0,
    apiKeyPlaceholder: "io-v2-... (180-day, rotate)",
  },
  {
    kind: "akashml",
    label: "AkashML",
    // api.akashml.com - Akash Network decentralized GPU. Base is root; runner + discovery
    // append /v1 -> /v1/chat/completions + /v1/models. 6 models, all overlap io.net
    // (DeepSeek-V4-Flash, Kimi-K2.7-Code, Qwen3.5/3.6-35B, Llama-3.3-70B, MiniMax-M2.5).
    // Wired as a failover backend. $100 signup credit then PAYG (card-gated), not permanent free.
    defaultBaseUrl: "https://api.akashml.com",
    defaultRatio: 0,
    apiKeyPlaceholder: "akml-... (akashml.com)",
  },
  {
    kind: "naga",
    label: "NagaAI",
    // api.naga.ac - multi-vendor gateway. Base is root; runner + discovery append /v1.
    // Free tier (~11 :free models): chat (nemotron-3-ultra/super, llama-3.3-70b, llama-4-scout,
    // sonar) + image (dall-e-3, flux-1-schnell, sdxl) + audio (eleven-multilingual-v2 TTS,
    // gpt-4o-mini-tts, whisper STT). Authentic (served model matches request). OAuth/email signup,
    // no card. ChimeraGPT lineage but real free tier; probe drops flaky/capacity-gated models.
    defaultBaseUrl: "https://api.naga.ac",
    defaultRatio: 0,
    imageChannelType: 1,
    audioChannelType: 1,
    // Free tier has a tight shared RPM; probing all 11 models in a burst trips 429.
    // 429 = capacity, not a dead model - keep it (live traffic spaces out).
    acceptRateLimited: true,
    apiKeyPlaceholder: "ng-... (naga.ac)",
  },
  {
    kind: "sensenova",
    label: "SenseNova",
    // 商汤 SenseTime Token Plan (token.sensenova.cn). Base is root; runner + discovery append /v1.
    // Free public beta 1500 calls/5h/model: sensenova-6.7-flash-lite, sensenova-u1-fast (multimodal),
    // deepseek-v4-flash. +86 signup (no real-name). Dynamic discovery.
    defaultBaseUrl: "https://token.sensenova.cn",
    defaultRatio: 0,
    acceptRateLimited: true,
    apiKeyPlaceholder: "sk-... (platform.sensenova.cn token plan)",
  },
  {
    kind: "internlm",
    label: "InternLM",
    // 书生 Shanghai AI Lab. chat.intern-ai.org.cn; base ends /api, runner + discovery append /v1.
    // ~90M tokens/month free, own models (internlm3-latest, internvl2.5-latest vision). GitHub/email
    // signup, no real-name. Dynamic discovery.
    defaultBaseUrl: "https://chat.intern-ai.org.cn/api",
    defaultRatio: 0,
    apiKeyPlaceholder: "<internlm token> (internlm.intern-ai.org.cn/api/tokens)",
  },
  {
    kind: "streamlake",
    label: "StreamLake",
    // 快手 Kuaishou Vanchin. Base ends at /coding; runner appends /v1 -> /api/gateway/coding/v1/
    // chat/completions. Curated: kat-coder-air-v1 (agentic coding, PERMANENTLY FREE). Pro models
    // Coding-Plan-gated. Google/email signup, no real-name. No /models endpoint.
    defaultBaseUrl: "https://vanchin.streamlake.ai/api/gateway/coding",
    defaultRatio: 0,
    apiKeyPlaceholder: "<streamlake key> (console.streamlake.ai)",
  },
  {
    kind: "qiniu",
    label: "Qiniu",
    // openai.qiniu.com - 七牛 CN platform, 65 frontier (deepseek-v4, kimi-k2.7, glm-5.2,
    // minimax-m3, qwen3.7-max, doubao, mimo, claude-fable-5). 3M free tokens/year. OpenAI +
    // Anthropic dual protocol. Base is root; runner + discovery append /v1. Email intl signup
    // (no CN phone) + real-name. Vendor-prefixed ids bare-collapse into canonicals.
    defaultBaseUrl: "https://openai.qiniu.com",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk-... (qiniu.com/ai, intl email signup)",
  },
  {
    kind: "infercom",
    label: "Infercom",
    // api.infercom.ai - EU/Germany-hosted, GDPR, zero-retention. OpenAI-compat. EUR5 signup
    // credit (no card) then PAYG. 9 models: DeepSeek-V3.1/V3.2, Llama-3.3-70B, MiniMax-M2.5/M2.7,
    // gemma-4-31b, gpt-oss-120b + Whisper (audio) + E5-Mistral (embedding). Failover lane.
    defaultBaseUrl: "https://api.infercom.ai",
    defaultRatio: 0,
    audioChannelType: 1,
    apiKeyPlaceholder: "<infercom key> (infercom.ai)",
  },
  {
    kind: "minimax",
    label: "MiniMax",
    // api.minimax.io - direct MiniMax (distinct vendor). OpenAI-compat. Trial credits (email/
    // phone signup, no card). Frontier M2.x/M3, 1M context. Dynamic; probe drops failures.
    defaultBaseUrl: "https://api.minimax.io",
    defaultRatio: 0,
    apiKeyPlaceholder: "<minimax key> (platform.minimax.io)",
  },
  {
    kind: "ollama",
    label: "Ollama Cloud",
    // ollama.com - OpenAI-compat. Base is root; runner + discovery append /v1. Free tier ~21
    // models (gpt-oss, gemma3/4, minimax, nemotron-3, qwen3-coder, ministral-3, devstral, rnj-1);
    // ~14 frontier (deepseek-v4/v3.2, kimi-k2.x, glm-5.x) are subscription-gated -> probe drops.
    // GPU-time metered (5h+weekly reset). Static key via ollama.com/settings/keys (GitHub OAuth).
    defaultBaseUrl: "https://ollama.com",
    defaultRatio: 0,
    apiKeyPlaceholder: "<id>.<secret> (ollama.com/settings/keys)",
  },
  {
    kind: "voidai",
    label: "VoidAI",
    // api.voidai.app - multi-vendor gateway. Base is root; runner + discovery append /v1.
    // Free tier ~77 models BUT gpt-5.x/o3/o4/claude/gemini-pro are FAKED (gpt-5.2 self-reports
    // GPT-4.1) or plan-gated -> discovery excludes them. Keeps ~39 authentic opens (deepseek/
    // kimi/glm/qwen/gemini-flash/gpt-oss/sonar + image/embedding). OAuth signup, no card.
    defaultBaseUrl: "https://api.voidai.app",
    defaultRatio: 0,
    imageChannelType: 1,
    audioChannelType: 1,
    apiKeyPlaceholder: "sk-voidai-... (voidai.app)",
  },
  {
    kind: "zanity",
    label: "Zanity",
    // api.zanity.xyz - RP-focused gateway. Base is root; runner + discovery append /v1.
    // Free tier 100K tok/day, 500 req/day, no card. ~27 free (access.free): llama family,
    // deepseek, mistral, flux, bge, whisper, elevenlabs/speechify TTS + house RP (zanity-rp-large,
    // grok-fun). Discord-community signup. Probe drops flaky (zanity-rp-large).
    defaultBaseUrl: "https://api.zanity.xyz",
    defaultRatio: 0,
    imageChannelType: 1,
    audioChannelType: 1,
    // Free tier 500 req/day shared; burst-probing trips 429. 429 = capacity, keep the model.
    acceptRateLimited: true,
    apiKeyPlaceholder: "vc-... (zanity.xyz)",
  },
  {
    kind: "nscale",
    label: "Nscale",
    // inference.api.nscale.com - serverless GPU cloud. Base is root; runner + discovery append
    // /v1 -> /v1/chat/completions + /v1/models. 31 models: small/distill text (Qwen3, R1-Distills,
    // Llama, gpt-oss, Kimi-K2.5) + image (FLUX.1-schnell/SDXL). PAYG (all billed), $5 signup credit.
    // Service token (nsk JWT, ~3-month expiry - rotate). Cheap failover lane; pricing cap holds.
    defaultBaseUrl: "https://inference.api.nscale.com",
    defaultRatio: 0,
    imageChannelType: 1,
    apiKeyPlaceholder: "eyJ... (nscale service token, 3-month - rotate)",
  },
  {
    kind: "aionlabs",
    label: "Aion Labs",
    // api.aionlabs.ai/v1; /v1/models returns a { models: [...] } envelope. 5 models
    // (aion-1.0/-mini/-2.0/-2.5 + aion-rp RP finetune); free tier, probe drops the
    // dead/empty ones. 15 RPM / 20K tok/day.
    defaultBaseUrl: "https://api.aionlabs.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "alv2_... (aionlabs.ai)",
  },
  {
    kind: "meganova",
    label: "MegaNova",
    // api.meganova.ai/v1 RP-focused gateway (Character Studio). Email signup + Turnstile.
    // Daily-reset free quota on a subset (RP finetunes: Nevoria/Stheno/Euryale/Sapphira/
    // Violet-Lotus + Mistral-Small + manta house); frontier (DeepSeek/GLM/claude/gemini)
    // credit-gated. Discovery drops non-text; probe drops the credit-gated. vendor/model
    // slugs collapse to bare names via the normalizer.
    defaultBaseUrl: "https://api.meganova.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk-... (console.meganova.ai)",
  },
  {
    kind: "crowllm",
    label: "CrowLLM",
    // crowllm.com/v1 NewAPI gateway. Discord signup, $2 one-time credit, NO online
    // topup (zero charge risk; dies when spent). Honest model ids (response model
    // matches request). ~31 models: deepseek-v3/v3.2/v4, glm-4.6/4.7/5.x, kimi-k2.6
    // variants, grok-4.x, ernie-5.1/4.5 (Baidu), gpt-oss-120b. Free lanes + bonus.
    defaultBaseUrl: "https://crowllm.com",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk-... (crowllm.com)",
  },
  {
    kind: "freemodel",
    label: "FreeModel",
    // api.freemodel.dev OpenAI-compatible. Google/email signup, NO card; 1-month Pro
    // trial unlocks the FULL frontier catalog (Claude opus/sonnet/haiku/fable, GPT-5.x,
    // o3, Gemini). Its /v1/models lies (advertises only 4 GPT rows) so discovery uses
    // a curated CONSTANT list, not the endpoint. The only free Claude lane we have.
    defaultBaseUrl: "https://api.freemodel.dev",
    defaultRatio: 0,
    apiKeyPlaceholder: "fe_oa_... (freemodel.dev)",
  },
  {
    kind: "scaleway",
    label: "Scaleway",
    // Generative APIs (api.scaleway.ai/v1); base is the host, runner + discovery
    // append /v1. OpenAI-compatible; Bearer = IAM secret key (access-key id unused).
    // EU-hosted, stable. 1M free tokens/new account then pay-per-use (gate behind a
    // locked card). ~17 models: gemma-4, qwen3.5/3.6, mistral-medium-3.5, llama-3.3,
    // gpt-oss-120b, devstral, plus embeddings/audio. Audio is OpenAI-shaped -> type 1.
    defaultBaseUrl: "https://api.scaleway.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "IAM secret key (uuid)",
    audioChannelType: 1,
  },
  {
    kind: "navyai",
    label: "NavyAI",
    // Freemium aggregator (api.navy/v1); base is the host, runner + discovery append
    // /v1. Free tier = ~157 non-premium models (GPT-5 line, o3, Gemini 2.5/3, full
    // DeepSeek, Grok-4.x, Mistral, Cohere); 150k TPD / 20 RPD. Discovery filters out
    // premium:true (paid-only) rows. Discord acct >= 7 days to generate a key.
    defaultBaseUrl: "https://api.navy",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk-navy-...",
    // 20 RPD / 150k TPD free tier: the burst probe trips 429 rpm_limit on live
    // models. Accept 429 so they're kept, but emitted disabled - new-api's
    // auto-test enables each once the per-minute window clears.
    acceptRateLimited: true,
  },
  {
    kind: "logfare",
    label: "Logfare",
    // OpenAI-compatible (logfare.ai/v1); base is the host, runner + discovery append
    // /v1. Free, no rate limits; account-level training opt-in unlocks all models.
    // Upstreams are flaky (frequent "temporarily unavailable") so the probe keeps
    // only what responds at sync time. ~8 models (deepseek/kimi/glm/gemini).
    defaultBaseUrl: "https://logfare.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "lfu_... (logfare.ai/register)",
  },
  {
    kind: "opencodezen",
    label: "OpenCode Zen",
    // OpenAI-compatible; base is the host + "/zen", runner + discovery append /v1.
    // Curated coding/RP catalog; only the "-free" variants + big-pickle work without
    // billing (discovery filters to those). Instant key from opencode.ai/auth, no card.
    defaultBaseUrl: "https://opencode.ai/zen",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk-... (opencode.ai/auth)",
  },
  {
    kind: "zai",
    label: "Z.ai",
    // Host only: new-api's ZHIPU_V4 (26) adapter appends /api/paas/v4/chat/completions
    // itself, and the sync probe mirrors that path. A base with /api/paas/v4 would
    // double the path and 404.
    defaultBaseUrl: "https://api.z.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "{id}.{secret}",
    channelType: 26,
  },
  {
    kind: "kilo",
    label: "Kilo Code",
    // api.kilo.ai/api/gateway - OpenAI-compat coding gateway. KEYLESS for free models
    // (200 req/hr per IP); base is the gateway root, new-api + runner append
    // /v1/chat/completions, discovery fetches /models (no /v1). ~9 :free models
    // (nemotron-3-ultra-550b/super-120b/nano-omni/content-safety, stepfun/step-3.7-flash,
    // nex-agi/nex-n2-pro, cohere/north-mini-code, poolside/laguna-m.1+xs.2). Big contexts
    // (up to 1M). vendor/model slugs bare-collapse via the normalizer.
    defaultBaseUrl: "https://api.kilo.ai/api/gateway",
    defaultRatio: 0,
    // Free pool is shared per-IP (200 req/hr); burst-probing can 429. 429 = capacity, keep.
    acceptRateLimited: true,
    apiKeyPlaceholder: "keyless (or kilo.ai key)",
  },
  {
    kind: "uncloseai",
    label: "UncloseAI",
    // hermes.ai.unturf.com - UncloseAI/unturf community permacomputer, vllm-served, KEYLESS
    // (no signup/card). Base is the host; runner + discovery append /v1. 1 chat model:
    // Hermes-3-Llama-3.1-8B (Nous Research, RP-capable, 82k ctx). Sibling hosts (qwen closed,
    // speech TTS) are separate subdomains, not wired here. Community-hosted -> can be slow/down.
    defaultBaseUrl: "https://hermes.ai.unturf.com",
    defaultRatio: 0,
    acceptRateLimited: true,
    apiKeyPlaceholder: "keyless",
  },
] as const satisfies readonly SimpleProviderMeta[];

export type SimpleProviderKind = (typeof SIMPLE_PROVIDER_META)[number]["kind"];

export const SIMPLE_PROVIDER_META_MAP: Record<string, SimpleProviderMeta> =
  Object.fromEntries(SIMPLE_PROVIDER_META.map((m) => [m.kind, m]));
