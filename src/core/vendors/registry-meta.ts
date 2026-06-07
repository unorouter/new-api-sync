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
