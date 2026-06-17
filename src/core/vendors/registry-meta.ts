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
    kind: "navyai",
    label: "NavyAI",
    // Freemium aggregator (api.navy/v1); base is the host, runner + discovery append
    // /v1. Free tier = ~157 non-premium models (GPT-5 line, o3, Gemini 2.5/3, full
    // DeepSeek, Grok-4.x, Mistral, Cohere); 150k TPD / 20 RPD. Discovery filters out
    // premium:true (paid-only) rows. Discord acct >= 7 days to generate a key.
    defaultBaseUrl: "https://api.navy",
    defaultRatio: 0,
    apiKeyPlaceholder: "sk-navy-...",
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
] as const satisfies readonly SimpleProviderMeta[];

export type SimpleProviderKind = (typeof SIMPLE_PROVIDER_META)[number]["kind"];

export const SIMPLE_PROVIDER_META_MAP: Record<string, SimpleProviderMeta> =
  Object.fromEntries(SIMPLE_PROVIDER_META.map((m) => [m.kind, m]));
